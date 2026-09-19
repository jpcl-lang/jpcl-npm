/** Tests for the .jp parser, writer, file helpers, config object and CLI. */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as jpcl from "../src/index.js";
import { JPConfig, JPDecodeError, JPEncodeError, JPError } from "../src/index.js";
import { main, type CliIO } from "../src/cli.js";

const SAMPLE = `[SERVER_ID]
config: {
  disabled_channels:,
  disabled_users: [9892, 82082, 8209]
}

[SERVER_ID_2]
prefix: "!"
modules: {
  moderation: true,
  fun: false
}
`;

const SAMPLE_DATA = {
  SERVER_ID: {
    config: {
      disabled_channels: null,
      disabled_users: [9892, 82082, 8209],
    },
  },
  SERVER_ID_2: {
    prefix: "!",
    modules: { moderation: true, fun: false },
  },
};

const temps: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jpcl-test-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function decodeError(fn: () => unknown): JPDecodeError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(JPDecodeError);
    return error as JPDecodeError;
  }
  throw new Error("expected a JPDecodeError");
}

// -- reading ------------------------------------------------------------------

describe("reading", () => {
  test("parses the reference document", () => {
    expect(jpcl.loads(SAMPLE)).toEqual(SAMPLE_DATA);
  });

  test("empty value becomes null", () => {
    expect(jpcl.loads("[s]\na:,\nb:\nc: 1\n").s).toEqual({ a: null, b: null, c: 1 });
  });

  test("comments and blank lines are ignored", () => {
    const text = `
    # leading comment

    [s]   # after a header
      a: 1  # after a value
      # between entries
      b: {
        # inside an object
        c: [1, 2]  # inside, after a value
      }
    `;
    expect(jpcl.loads(text)).toEqual({ s: { a: 1, b: { c: [1, 2] } } });
  });

  test("trailing commas are allowed", () => {
    expect(jpcl.loads("[s]\no: {a: 1, b: 2,}\nl: [1, 2, 3,]\n").s).toEqual({
      o: { a: 1, b: 2 },
      l: [1, 2, 3],
    });
  });

  test("repeated and leading commas are tolerated", () => {
    expect(jpcl.loads("[s]\no: {,a: 1,, b: 2,}\nl: [,1,,2,]\n").s).toEqual({
      o: { a: 1, b: 2 },
      l: [1, 2],
    });
  });

  test("entries may be separated by newlines, commas or both", () => {
    const text = "[s]\no: {\n  a: 1\n  b: 2,\n  c: 3,\n}\nl: [\n  1\n  2,\n]\n";
    expect(jpcl.loads(text).s).toEqual({ o: { a: 1, b: 2, c: 3 }, l: [1, 2] });
  });

  test("multiple keys per section keep order", () => {
    expect(Object.keys(jpcl.loads("[s]\nz: 1\na: 2\nm: 3\n").s as object)).toEqual(["z", "a", "m"]);
  });

  test("scalar types", () => {
    const text = [
      "[s]",
      "i: 42",
      "neg: -7",
      "f: 3.5",
      "exp: 1e3",
      "under: 1_000",
      "hex: 0xff",
      "oct: 0o755",
      "bin: -0b1010",
      "t: true",
      "f2: False",
      "n: null",
      's: "quoted"',
      "s2: 'single'",
      "bare: hello world",
      "notnum: 0xzz",
      "",
    ].join("\n");
    expect(jpcl.loads(text).s).toEqual({
      i: 42,
      neg: -7,
      f: 3.5,
      exp: 1000,
      under: 1000,
      hex: 255,
      oct: 493,
      bin: -10,
      t: true,
      f2: false,
      n: null,
      s: "quoted",
      s2: "single",
      bare: "hello world",
      notnum: "0xzz",
    });
  });

  test("large integers keep every digit as bigint", () => {
    const section = jpcl.loads("[s]\nid: 111111111111111111\nsmall: 9007199254740991\n").s as any;
    expect(section.id).toBe(111111111111111111n);
    expect(section.small).toBe(9007199254740991);
  });

  test("integers option", () => {
    expect((jpcl.loads("[s]\na: 1\n", { integers: "bigint" }).s as any).a).toBe(1n);
    expect((jpcl.loads("[s]\na: 111111111111111111\n", { integers: "number" }).s as any).a).toBe(
      111111111111111111,
    );
    expect(() => jpcl.loads("", { integers: "nope" as any })).toThrow(RangeError);
  });

  test("non-finite floats", () => {
    const section = jpcl.loads("[s]\na: inf\nb: -inf\nc: nan\nd: -Infinity\n").s as any;
    expect(section.a).toBe(Infinity);
    expect(section.b).toBe(-Infinity);
    expect(section.c).toBeNaN();
    expect(section.d).toBe(-Infinity);
  });

  test("string escapes", () => {
    const text = String.raw`[s]` + "\n" + String.raw`a: "tab\there\nline \u00e9 \U0001F600 \"q\" \\"` + "\n";
    expect((jpcl.loads(text).s as any).a).toBe('tab\there\nline é 😀 "q" \\');
  });

  test("surrogate pair escape", () => {
    expect((jpcl.loads(String.raw`[s]` + "\n" + String.raw`a: "\ud83d\ude00"` + "\n").s as any).a).toBe("😀");
  });

  test("backslash-newline continues a string", () => {
    expect((jpcl.loads('[s]\na: "one \\\n     two"\n').s as any).a).toBe("one two");
  });

  test("quoted keys allow any character", () => {
    expect(jpcl.loads('[s]\n"a b: c": 1\n').s).toEqual({ "a b: c": 1 });
  });

  test("keys before any header land at the root", () => {
    expect(jpcl.loads("version: 2\n\n[s]\na: 1\n")).toEqual({ version: 2, s: { a: 1 } });
  });

  test("dotted headers nest", () => {
    expect(jpcl.loads("[a.b.c]\nx: 1\n\n[a.d]\ny: 2\n")).toEqual({
      a: { b: { c: { x: 1 } }, d: { y: 2 } },
    });
  });

  test("quoted header segment is not split", () => {
    expect(jpcl.loads('["a.b"]\nx: 1\n')).toEqual({ "a.b": { x: 1 } });
  });

  test("deeply nested containers", () => {
    expect((jpcl.loads("[s]\na: {b: [{c: [1, {d: 2}]}]}\n") as any).s.a.b[0].c[1].d).toBe(2);
  });

  test("empty containers", () => {
    expect(jpcl.loads("[s]\na: {}\nb: []\n").s).toEqual({ a: {}, b: [] });
  });

  test("empty document", () => {
    expect(jpcl.loads("")).toEqual({});
    expect(jpcl.loads("# just a comment\n\n")).toEqual({});
  });

  test("empty section", () => {
    expect(jpcl.loads("[a]\n\n[b]\nx: 1\n")).toEqual({ a: {}, b: { x: 1 } });
  });

  test("CRLF and BOM are handled", () => {
    expect(jpcl.loads("\ufeff[s]\r\na: 1\r\n")).toEqual({ s: { a: 1 } });
  });

  test("__proto__ is an ordinary key", () => {
    const data = jpcl.loads("[s]\n__proto__: {polluted: true}\n") as any;
    expect(Object.getPrototypeOf(data.s)).toBe(Object.prototype);
    expect(Object.keys(data.s)).toEqual(["__proto__"]);
    expect(({} as any).polluted).toBeUndefined();
  });

  test("keys that exist on Object.prototype are not duplicates", () => {
    expect(jpcl.loads("[toString]\nconstructor: 1\n")).toEqual({ toString: { constructor: 1 } } as any);
  });

  test("parse is an alias of loads", () => {
    expect(jpcl.parse(SAMPLE)).toEqual(SAMPLE_DATA);
  });
});

// -- duplicate keys -------------------------------------------------------------

describe("duplicate keys", () => {
  test("raise by default", () => {
    expect(() => jpcl.loads("[s]\na: 1\na: 2\n")).toThrow("duplicate key 'a'");
  });

  test("policies", () => {
    const text = "[s]\na: 1\na: 2\n";
    expect((jpcl.loads(text, { duplicateKeys: "first" }).s as any).a).toBe(1);
    expect((jpcl.loads(text, { duplicateKeys: "last" }).s as any).a).toBe(2);
  });

  test("duplicate section raises", () => {
    expect(() => jpcl.loads("[s]\na: 1\n\n[s]\nb: 2\n")).toThrow("section '[s]' is defined twice");
  });

  test("duplicate section merges under the last policy", () => {
    expect(jpcl.loads("[s]\na: 1\n\n[s]\nb: 2\n", { duplicateKeys: "last" })).toEqual({
      s: { a: 1, b: 2 },
    });
  });

  test("invalid policy rejected", () => {
    expect(() => jpcl.loads("", { duplicateKeys: "nope" as any })).toThrow("duplicateKeys");
  });
});

// -- errors ---------------------------------------------------------------------

describe("errors", () => {
  test.each([
    ["[s]\na 1\n", "expected ':' after key"],
    ["[s]\na: {b: 1\n", "unterminated object"],
    ["[s]\na: [1, 2\n", "unterminated array"],
    ["[s\na: 1\n", "unterminated section header"],
    ["[]\na: 1\n", "section header cannot be empty"],
    ['[s]\na: "open\n', "unterminated string"],
    [String.raw`[s]` + "\n" + String.raw`a: "\q"` + "\n", "invalid escape sequence"],
    [String.raw`[s]` + "\n" + String.raw`a: "\u12"` + "\n", "escape needs 4 hex digits"],
    ['[s]\na: "x" "y"\n', "expected ',' or a line break"],
    ['[s]\na: {b: "1" extra}\n', "expected ',', a line break or '}'"],
    ["[s]\n: 1\n", "expected a key"],
    ["[s] junk\na: 1\n", "unexpected 'j' after section header"],
    ["version: 1\n[s.]\na: 1\n", "section header segment cannot be empty"],
  ])("syntax error in %j", (text, message) => {
    expect(decodeError(() => jpcl.loads(text)).rawMessage).toContain(message);
  });

  test("reports line, column and source", () => {
    const error = decodeError(() => jpcl.loads('[s]\nprefix "!"\n', { filename: "servers.jp" }));
    expect([error.line, error.col]).toEqual([2, 8]);
    expect(error.filename).toBe("servers.jp");
    expect(error.message).toBe(
      `servers.jp:2:8: expected ':' after key 'prefix', found '"'\n    prefix "!"\n           ^`,
    );
    expect(error).toBeInstanceOf(JPError);
    expect(error).toBeInstanceOf(Error);
  });

  test("section cannot shadow a scalar", () => {
    expect(() => jpcl.loads("a: 1\n\n[a.b]\nx: 1\n")).toThrow("already a non-section value");
  });

  test("nesting depth is capped", () => {
    expect(() => jpcl.loads(`[s]\na: ${"[".repeat(500)}${"]".repeat(500)}\n`)).toThrow("nesting deeper than");
  });
});

// -- writing --------------------------------------------------------------------

describe("writing", () => {
  test("dumps matches the reference style", () => {
    expect(jpcl.dumps(SAMPLE_DATA)).toBe(SAMPLE);
  });

  test("round trip is stable", () => {
    const once = jpcl.dumps(jpcl.loads(SAMPLE));
    expect(jpcl.dumps(jpcl.loads(once))).toBe(once);
  });

  test("example data round-trips", () => {
    const text = fs.readFileSync(path.join(import.meta.dir, "../data/servers.example.jp"), "utf8");
    const data = jpcl.loads(text);
    expect(jpcl.loads(jpcl.dumps(data))).toEqual(data);
  });

  test("null is empty in objects and null in arrays", () => {
    const text = jpcl.dumps({ s: { a: null, b: [null, 1] } });
    expect(text).toContain("a:\n");
    expect(text).toContain("b: [null, 1]");
    expect(jpcl.loads(text)).toEqual({ s: { a: null, b: [null, 1] } });
  });

  test("undefined is skipped in objects and null in arrays", () => {
    expect(jpcl.dumps({ s: { a: undefined, b: [undefined] } })).toBe("[s]\nb: [null]\n");
  });

  test("long arrays break onto multiple lines", () => {
    const ids = Array.from({ length: 30 }, (_, i) => i);
    const text = jpcl.dumps({ s: { ids } });
    expect(text).toContain("ids: [\n");
    expect((jpcl.loads(text).s as any).ids).toEqual(ids);
  });

  test("scalar roots are hoisted above sections", () => {
    const text = jpcl.dumps({ s: { a: 1 }, version: 2 });
    expect(text.indexOf("version: 2")).toBeLessThan(text.indexOf("[s]"));
    expect(jpcl.loads(text)).toEqual({ version: 2, s: { a: 1 } });
  });

  test("keys are quoted only when necessary", () => {
    const data = { "ok_key-1": { plain: 1, "needs quotes": 2, "": 3 } };
    const text = jpcl.dumps(data);
    expect(text).toContain("[ok_key-1]");
    expect(text).toContain('"needs quotes": 2');
    expect(text).toContain('"": 3');
    expect(jpcl.loads(text)).toEqual(data);
  });

  test("Map keys may be integers", () => {
    const data = new Map<unknown, unknown>([[123, { a: 1 }], [456n, new Map([["b", 2]])]]);
    expect(jpcl.loads(jpcl.dumps(data))).toEqual({ "123": { a: 1 }, "456": { b: 2 } });
    expect(() => jpcl.dumps(new Map([[{}, 1]]))).toThrow("keys must be strings");
  });

  test("bigint round-trips", () => {
    const data = { s: { id: 111111111111111111n, ids: [222222222222222222n] } };
    expect(jpcl.loads(jpcl.dumps(data))).toEqual(data);
  });

  test("string values are escaped", () => {
    const value = 'quote " backslash \\ newline \n tab \t bell \x07 del \x7f';
    expect((jpcl.loads(jpcl.dumps({ s: { a: value } })).s as any).a).toBe(value);
  });

  test("ensureAscii option", () => {
    expect(jpcl.dumps({ s: { a: "é😀" } }, { ensureAscii: true })).toContain("\\u00e9\\ud83d\\ude00");
    expect(jpcl.dumps({ s: { a: "é" } })).toContain("é");
  });

  test("indent and sortKeys options", () => {
    const text = jpcl.dumps({ s: { b: 1, a: { z: 1 } } }, { indent: 4, sortKeys: true });
    expect(text.indexOf("a: {")).toBeLessThan(text.indexOf("b: 1"));
    expect(text).toContain("\n    z: 1");
  });

  test("width option", () => {
    expect(jpcl.dumps({ s: { a: [1, 2, 3] } }, { width: 8 })).toBe("[s]\na: [\n  1,\n  2,\n  3\n]\n");
  });

  test("floats and non-finite numbers", () => {
    const text = jpcl.dumps({ s: { a: 0.1, b: Infinity, c: -Infinity, d: NaN, e: 1e-7 } });
    expect(text).toBe("[s]\na: 0.1\nb: inf\nc: -inf\nd: nan\ne: 1e-07\n");
    const back = jpcl.loads(text).s as any;
    expect(back.e).toBe(1e-7);
    expect(back.d).toBeNaN();
  });

  test.each([
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [-2.5e-10, "-2.5e-10"],
    [123456.789, "123456.789"],
    [999999999999999, "999999999999999"],
    [1e16, "1e+16"],
    [1.5e300, "1.5e+300"],
    [-1e21, "-1e+21"],
  ])("numbers are formatted like Python's repr: %p", (value, expected) => {
    const text = jpcl.dumps({ s: { a: value } });
    expect(text).toBe(`[s]\na: ${expected}\n`);
    expect((jpcl.loads(text).s as any).a).toBe(value);
  });

  test("unserialisable type throws", () => {
    expect(() => jpcl.dumps({ s: { a: new Date(0) } })).toThrow(JPEncodeError);
    expect(() => jpcl.dumps({ s: { a: () => 1 } })).toThrow("not serialisable");
  });

  test("default hook converts unknown types", () => {
    const text = jpcl.dumps(
      { s: { when: new Date(Date.UTC(2026, 8, 12)) } },
      { default: (v) => (v as Date).toISOString().slice(0, 10) },
    );
    expect((jpcl.loads(text).s as any).when).toBe("2026-09-12");
  });

  test("default hook must convert", () => {
    expect(() => jpcl.dumps({ s: { a: new Date(0) } }, { default: (v) => v })).toThrow("unconverted");
  });

  test("binary data is rejected with a hint", () => {
    expect(() => jpcl.dumps({ s: { a: new Uint8Array([1]) } })).toThrow("binary data");
  });

  test("circular reference is detected", () => {
    const section: Record<string, unknown> = {};
    section.self = section;
    expect(() => jpcl.dumps({ s: section })).toThrow("circular reference");
  });

  test("shared (non-circular) references are fine", () => {
    const shared = [1, 2];
    expect(jpcl.dumps({ s: { a: shared, b: shared } })).toBe("[s]\na: [1, 2]\nb: [1, 2]\n");
  });

  test("top level must be an object", () => {
    expect(() => jpcl.dumps([1, 2])).toThrow("must be an object");
  });

  test("dumps of empty document", () => {
    expect(jpcl.dumps({})).toBe("");
  });

  test("stringify is an alias of dumps", () => {
    expect(jpcl.stringify(SAMPLE_DATA)).toBe(SAMPLE);
  });
});

// -- files ----------------------------------------------------------------------

describe("files", () => {
  test("load and dump paths", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "servers.jp");
    fs.writeFileSync(file, SAMPLE);
    const data = await jpcl.load(file);
    expect(data).toEqual(SAMPLE_DATA);
    const out = path.join(dir, "copy.jp");
    await jpcl.dump(data, out);
    expect(fs.readFileSync(out, "utf8")).toBe(SAMPLE);
  });

  test("sync variants and file URLs", () => {
    const dir = tmpDir();
    const url = new URL(`file:///${path.join(dir, "a.jp").replaceAll("\\", "/").replace(/^\//, "")}`);
    jpcl.dumpSync({ s: { a: 1 } }, url);
    expect(jpcl.loadSync(url)).toEqual({ s: { a: 1 } });
  });

  test("dump is atomic and leaves no temp files", async () => {
    const dir = tmpDir();
    await jpcl.dump({ s: { a: 1 } }, path.join(dir, "a.jp"));
    jpcl.dumpSync({ s: { a: 2 } }, path.join(dir, "a.jp"));
    expect(fs.readdirSync(dir)).toEqual(["a.jp"]);
    expect(jpcl.loadSync(path.join(dir, "a.jp"))).toEqual({ s: { a: 2 } });
  });

  test("failed encode leaves the existing file untouched", async () => {
    const dir = tmpDir();
    const file = path.join(dir, "a.jp");
    fs.writeFileSync(file, SAMPLE);
    await expect(jpcl.dump({ s: { a: Symbol() } }, file)).rejects.toThrow(JPEncodeError);
    expect(fs.readFileSync(file, "utf8")).toBe(SAMPLE);
    expect(fs.readdirSync(dir)).toEqual(["a.jp"]);
  });

  test("non-atomic dump", async () => {
    const dir = tmpDir();
    await jpcl.dump({ s: { a: 1 } }, path.join(dir, "a.jp"), { atomic: false });
    expect(jpcl.loadSync(path.join(dir, "a.jp"))).toEqual({ s: { a: 1 } });
  });

  test("dump creates missing parent directories", async () => {
    const file = path.join(tmpDir(), "nested", "deep", "a.jp");
    await jpcl.dump({ s: { a: 1 } }, file);
    expect(await jpcl.load(file)).toEqual({ s: { a: 1 } });
  });

  test("error from a file names the file", async () => {
    const file = path.join(tmpDir(), "broken.jp");
    fs.writeFileSync(file, "[s]\na 1\n");
    await expect(jpcl.load(file)).rejects.toThrow("broken.jp");
  });

  test("loadDir", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "servers.jp"), SAMPLE);
    fs.writeFileSync(path.join(dir, "roles.jp"), "[r]\na: 1\n");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "nope");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "nested.jp"), "[n]\n");
    for (const loaded of [await jpcl.loadDir(dir), jpcl.loadDirSync(dir)]) {
      expect(Object.keys(loaded)).toEqual(["roles", "servers"]);
      expect(loaded.servers).toEqual(SAMPLE_DATA);
    }
  });

  test("loadDir recursive", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "guilds"));
    fs.writeFileSync(path.join(dir, "guilds", "a.jp"), "[s]\nx: 1\n");
    fs.writeFileSync(path.join(dir, "top.jp"), "");
    const expected = { "guilds/a": { s: { x: 1 } }, top: {} };
    expect(await jpcl.loadDir(dir, { recursive: true })).toEqual(expected);
    expect(jpcl.loadDirSync(dir, { recursive: true })).toEqual(expected);
  });

  test("loadDir pattern", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "a.example.jp"), "");
    fs.writeFileSync(path.join(dir, "b.jp"), "");
    expect(Object.keys(jpcl.loadDirSync(dir, { pattern: "*.example.jp" }))).toEqual(["a.example"]);
    expect(Object.keys(jpcl.loadDirSync(dir, { pattern: "[!a]*" }))).toEqual(["b"]);
  });

  test("loadDir on a missing directory", async () => {
    const missing = path.join(tmpDir(), "nope");
    await expect(jpcl.loadDir(missing)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(() => jpcl.loadDirSync(missing)).toThrow("no such config directory");
  });
});

// -- JPConfig -------------------------------------------------------------------

describe("JPConfig", () => {
  test("behaves like a map", () => {
    const config = JPConfig.loads(SAMPLE);
    expect(config.size).toBe(2);
    expect([...config.keys()]).toEqual(["SERVER_ID", "SERVER_ID_2"]);
    expect(config.get("SERVER_ID_2").prefix).toBe("!");
    expect(config.data.SERVER_ID_2.prefix).toBe("!");
    config.set("NEW", { a: 1 });
    expect(config.has("NEW")).toBe(true);
    expect(config.delete("NEW")).toBe(true);
    expect(config.has("NEW")).toBe(false);
    expect(config.delete("NEW")).toBe(false);
    expect(config.get("toString")).toBeUndefined();
    expect(new Map(config).size).toBe(2);
  });

  test("constructor copies rather than aliases", () => {
    const source: Record<string, unknown> = { a: 1 };
    new JPConfig(source).set("b", 2);
    expect(source).toEqual({ a: 1 });
  });

  test("dotted paths", () => {
    const config = JPConfig.loads(SAMPLE);
    expect(config.getPath("SERVER_ID.config.disabled_users")).toEqual([9892, 82082, 8209]);
    expect(config.getPath("SERVER_ID.config.disabled_channels")).toBeNull();
    expect(config.getPath("nope.nope", "fallback")).toBe("fallback");
    expect(config.getPath("SERVER_ID.config.disabled_users.length", "fallback")).toBe("fallback");
    expect(config.hasPath("SERVER_ID.config.disabled_channels")).toBe(true);
    expect(config.hasPath("SERVER_ID.missing")).toBe(false);
    expect(config.getPath("SERVER_ID/config", undefined, "/")).toEqual(SAMPLE_DATA.SERVER_ID.config);
  });

  test("setPath creates sections", () => {
    const config = new JPConfig();
    config.setPath("A.b.c", [1]);
    expect(config.toObject()).toEqual({ A: { b: { c: [1] } } });
  });

  test("setPath replaces an empty value", () => {
    const config = JPConfig.loads("[s]\nconfig:\n");
    config.setPath("s.config.a", 1);
    expect(config.toObject()).toEqual({ s: { config: { a: 1 } } });
  });

  test("setPath refuses to descend into a scalar", () => {
    const config = JPConfig.loads("[s]\na: 1\n");
    expect(() => config.setPath("s.a.b", 2)).toThrow(TypeError);
    expect(() => config.setPath("s.a.b", 2)).toThrow("cannot descend");
  });

  test("section helper", () => {
    const config = JPConfig.loads(SAMPLE);
    expect(config.section("SERVER_ID_2").prefix).toBe("!");
    expect(() => config.section("missing")).toThrow(RangeError);
    expect(config.section("missing", { create: true })).toEqual({});
    config.set("scalar", 1);
    expect(() => config.section("scalar")).toThrow(TypeError);
  });

  test("merge is deep", () => {
    const config = JPConfig.loads(SAMPLE);
    config.merge({ SERVER_ID_2: { modules: { fun: true, logs: true } } });
    expect(config.data.SERVER_ID_2.modules).toEqual({ moderation: true, fun: true, logs: true });
    expect(config.data.SERVER_ID_2.prefix).toBe("!");
  });

  test("shallow merge replaces", () => {
    const config = JPConfig.loads(SAMPLE);
    config.merge({ SERVER_ID_2: { prefix: "?" } }, { deep: false });
    expect(config.data.SERVER_ID_2).toEqual({ prefix: "?" });
  });

  test("toObject is a deep copy", () => {
    const config = JPConfig.loads(SAMPLE);
    config.toObject().SERVER_ID.config.disabled_users.push(1);
    expect(config.getPath("SERVER_ID.config.disabled_users")).toEqual([9892, 82082, 8209]);
  });

  test("save and reload", async () => {
    const file = path.join(tmpDir(), "servers.jp");
    fs.writeFileSync(file, SAMPLE);
    const config = await JPConfig.load(file);
    config.setPath("SERVER_ID_2.prefix", "?");
    await config.save();
    expect((await JPConfig.load(file)).data.SERVER_ID_2.prefix).toBe("?");
    config.setPath("SERVER_ID_2.prefix", "unsaved");
    await config.reload();
    expect(config.data.SERVER_ID_2.prefix).toBe("?");
  });

  test("sync save and reload", () => {
    const file = path.join(tmpDir(), "servers.jp");
    fs.writeFileSync(file, SAMPLE);
    const config = JPConfig.loadSync(file);
    config.setPath("SERVER_ID_2.prefix", "?").saveSync();
    config.setPath("SERVER_ID_2.prefix", "unsaved").reloadSync();
    expect(config.data.SERVER_ID_2.prefix).toBe("?");
  });

  test("load with missingOk", async () => {
    const file = path.join(tmpDir(), "absent.jp");
    const config = await JPConfig.load(file, { missingOk: true });
    expect(config.toObject()).toEqual({});
    config.setPath("s.a", 1);
    expect(await config.save()).toBe(file);
    expect(await jpcl.load(file)).toEqual({ s: { a: 1 } });
    expect(JPConfig.loadSync(path.join(tmpDir(), "x.jp"), { missingOk: true }).size).toBe(0);
  });

  test("load of a missing file throws without missingOk", async () => {
    const file = path.join(tmpDir(), "absent.jp");
    await expect(JPConfig.load(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => JPConfig.loadSync(file)).toThrow();
  });

  test("save without a path", async () => {
    await expect(new JPConfig().save()).rejects.toThrow("no path");
    expect(() => new JPConfig().reloadSync()).toThrow("no path");
  });

  test("remembers write options", () => {
    const file = path.join(tmpDir(), "a.jp");
    new JPConfig({ s: { b: 1, a: 2 } }, { path: file, indent: 4, sortKeys: true }).saveSync();
    expect(fs.readFileSync(file, "utf8")).toBe("[s]\na: 2\nb: 1\n");
  });

  test("remembers read options", () => {
    const file = path.join(tmpDir(), "a.jp");
    fs.writeFileSync(file, "[s]\na: 1\na: 2\n");
    const config = JPConfig.loadSync(file, { duplicateKeys: "last" });
    expect(config.reloadSync().data.s.a).toBe(2);
  });

  test("rejects unknown options", () => {
    expect(() => new JPConfig(null, { nonsense: 1 } as any)).toThrow("unknown option");
  });

  test("toString mentions sections", () => {
    expect(String(JPConfig.loads(SAMPLE))).toContain("SERVER_ID");
  });
});

// -- command line ---------------------------------------------------------------

function run(argv: string[], stdin = ""): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: CliIO = {
    stdout: (text) => void (out += text),
    stderr: (text) => void (err += text),
    readStdin: () => stdin,
  };
  const code = main(argv, io);
  return { code, out, err };
}

function sampleFile(contents = SAMPLE): string {
  const file = path.join(tmpDir(), "a.jp");
  fs.writeFileSync(file, contents);
  return file;
}

describe("cli", () => {
  test("check ok", () => {
    const result = run(["check", sampleFile()]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("ok");
    expect(run(["check", "-q", sampleFile()]).out).toBe("");
  });

  test("check failure", () => {
    const result = run(["check", sampleFile("[s]\na 1\n")]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("expected ':'");
  });

  test("check a missing file", () => {
    const result = run(["check", path.join(tmpDir(), "nope.jp")]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("ENOENT");
  });

  test("check reads stdin", () => {
    expect(run(["check", "-"], SAMPLE).code).toBe(0);
    expect(run(["check", "-"], "[s]\na 1\n").err).toContain("<stdin>:2:4: expected ':' after key 'a 1'");
  });

  test("fmt writes in place", () => {
    const file = sampleFile("[s]\n  a:   {b:1,}\n");
    const result = run(["fmt", "-w", file]);
    expect(result.code).toBe(0);
    expect(result.err).toContain("reformatted");
    expect(fs.readFileSync(file, "utf8")).toBe("[s]\na: {\n  b: 1\n}\n");
    expect(run(["fmt", "-w", file]).err).toBe("");
  });

  test("fmt prints to stdout", () => {
    expect(run(["fmt", "--sort-keys", "-"], "[s]\nb: 1\na: 2\n").out).toBe("[s]\na: 2\nb: 1\n");
  });

  test("get", () => {
    const result = run(["get", sampleFile(), "SERVER_ID.config.disabled_users"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual([9892, 82082, 8209]);
    expect(run(["get", "-r", sampleFile(), "SERVER_ID_2.prefix"]).out).toBe("!\n");
    expect(run(["get", sampleFile("[s]\nid: 111111111111111111\n"), "s.id"]).out).toBe("111111111111111111\n");
  });

  test("get a missing path", () => {
    const result = run(["get", sampleFile(), "nope"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("no such path");
  });

  test("json conversions", () => {
    const source = sampleFile();
    const target = path.join(path.dirname(source), "a.json");
    expect(run(["to-json", source, "-o", target]).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual(SAMPLE_DATA);
    const back = path.join(path.dirname(source), "b.jp");
    expect(run(["from-json", target, "-o", back]).code).toBe(0);
    expect(fs.readFileSync(back, "utf8")).toBe(SAMPLE);
  });

  test("json conversions keep large integers", () => {
    const text = "[s]\nid: 111111111111111111\n";
    const json = run(["to-json", "-"], text).out;
    expect(json).toBe('{\n  "s": {\n    "id": 111111111111111111\n  }\n}\n');
    expect(run(["from-json", "-"], json).out).toBe(text);
  });

  test("from-json reports invalid input", () => {
    expect(run(["from-json", "-"], "{nope").code).toBe(1);
    expect(run(["from-json", "-"], "[1, 2]").err).toContain("must be an object");
  });

  test("usage errors exit 2", () => {
    expect(run([]).code).toBe(2);
    expect(run(["nope"]).err).toContain("invalid command");
    expect(run(["check"]).err).toContain("required: files");
    expect(run(["get", "a.jp"]).err).toContain("required: path");
    expect(run(["check", "--bogus", "a.jp"]).code).toBe(2);
    expect(run(["fmt", "--indent", "x", "a.jp"]).err).toContain("invalid non-negative int");
    expect(run(["to-json", "a.jp", "b.jp"]).err).toContain("unrecognized arguments");
  });

  test("help and version", () => {
    expect(run(["--help"]).out).toContain("from-json");
    expect(run(["fmt", "-h"]).out).toContain("--sort-keys");
    expect(run(["--version"]).out).toBe(`jpcl ${jpcl.version}\n`);
  });
});
