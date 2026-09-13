/**
 * Reading and writing `.jp` files, singly or a directory at a time. Every
 * function comes in an async form and a `...Sync` form.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ENCODING, SUFFIX, dumps, loads } from "./core.js";
import type { ParseOptions } from "./parser.js";
import type { JPObject } from "./values.js";
import type { StringifyOptions } from "./writer.js";

/** A filesystem path, as a string or a `file:` URL. */
export type PathLike = string | URL;

/** Options for {@link load}: everything {@link loads} takes except a filename. */
export type LoadOptions = Omit<ParseOptions, "filename">;

export interface DumpOptions extends StringifyOptions {
  /**
   * Write to a temporary file in the same directory and rename it into place,
   * so a crash or a concurrent reader never sees a half-written config.
   * Default `true`.
   */
  atomic?: boolean;
}

export interface LoadDirOptions extends LoadOptions {
  /** Glob applied to file names (`*`, `?`, `[abc]`). Default `"*.jp"`. */
  pattern?: string;
  /** Whether to descend into sub-folders. Default `false`. */
  recursive?: boolean;
}

export function toPath(path: PathLike): string {
  return path instanceof URL ? fileURLToPath(path) : path;
}

// -- single files ------------------------------------------------------------

/**
 * Read and parse a `.jp` file.
 *
 * @throws {JPDecodeError} If the document is malformed.
 */
export async function load(path: PathLike, options: LoadOptions = {}): Promise<JPObject> {
  const file = toPath(path);
  return loads(await fsp.readFile(file, ENCODING), { ...options, filename: file });
}

/** Synchronous {@link load}. */
export function loadSync(path: PathLike, options: LoadOptions = {}): JPObject {
  const file = toPath(path);
  return loads(fs.readFileSync(file, ENCODING), { ...options, filename: file });
}

/**
 * Serialise `value` and write it to `path`, creating missing parent folders.
 *
 * @throws {JPEncodeError} If `value` cannot be represented.
 */
export async function dump(value: unknown, path: PathLike, options: DumpOptions = {}): Promise<void> {
  const { atomic = true, ...format } = options;
  const text = dumps(value, format);
  const file = toPath(path);
  await fsp.mkdir(nodePath.dirname(file), { recursive: true });
  if (!atomic) return fsp.writeFile(file, text, ENCODING);

  const temp = tempName(file);
  const handle = await fsp.open(temp, "wx");
  try {
    try {
      await handle.writeFile(text, ENCODING);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
}

/** Synchronous {@link dump}. */
export function dumpSync(value: unknown, path: PathLike, options: DumpOptions = {}): void {
  const { atomic = true, ...format } = options;
  const text = dumps(value, format);
  const file = toPath(path);
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  if (!atomic) return fs.writeFileSync(file, text, ENCODING);

  const temp = tempName(file);
  const fd = fs.openSync(temp, "wx");
  try {
    try {
      fs.writeFileSync(fd, text, ENCODING);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** A hidden, unique neighbour of `file`, so the final rename stays on one volume. */
function tempName(file: string): string {
  const name = `.${nodePath.basename(file)}.${randomBytes(6).toString("hex")}.tmp`;
  return nodePath.join(nodePath.dirname(file), name);
}

// -- directories -------------------------------------------------------------

/**
 * Load every `.jp` file in `directory`, keyed by file name without its
 * extension.
 *
 * `data/servers.jp` and `data/roles.jp` become `{ servers: {...}, roles: {...} }`.
 * With `recursive: true` nested files are keyed by their relative path, using
 * `/` separators (`"guilds/1234567890"`).
 *
 * @throws {Error} With `code === "ENOTDIR"` if `directory` is not a folder.
 * @throws {JPDecodeError} If any document is malformed.
 */
export async function loadDir(
  directory: PathLike,
  options: LoadDirOptions = {},
): Promise<Record<string, JPObject>> {
  const { pattern = `*${SUFFIX}`, recursive = false, ...parse } = options;
  const root = toPath(directory);
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw notADirectory(root);

  const matcher = globToRegExp(pattern);
  const found: string[][] = [];
  const walk = async (segments: string[]): Promise<void> => {
    const entries = await fsp.readdir(nodePath.join(root, ...segments), { withFileTypes: true });
    for (const entry of entries) {
      const next = [...segments, entry.name];
      if (entry.isDirectory()) {
        if (recursive) await walk(next);
      } else if (matcher.test(entry.name) && (await isFile(nodePath.join(root, ...next)))) {
        found.push(next);
      }
    }
  };
  await walk([]);

  const result: Record<string, JPObject> = {};
  for (const segments of found.sort(compareSegments)) {
    result[dirKey(segments)] = await load(nodePath.join(root, ...segments), parse);
  }
  return result;
}

/** Synchronous {@link loadDir}. */
export function loadDirSync(
  directory: PathLike,
  options: LoadDirOptions = {},
): Record<string, JPObject> {
  const { pattern = `*${SUFFIX}`, recursive = false, ...parse } = options;
  const root = toPath(directory);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw notADirectory(root);

  const matcher = globToRegExp(pattern);
  const found: string[][] = [];
  const walk = (segments: string[]): void => {
    for (const entry of fs.readdirSync(nodePath.join(root, ...segments), { withFileTypes: true })) {
      const next = [...segments, entry.name];
      if (entry.isDirectory()) {
        if (recursive) walk(next);
      } else if (matcher.test(entry.name) && isFileSync(nodePath.join(root, ...next))) {
        found.push(next);
      }
    }
  };
  walk([]);

  const result: Record<string, JPObject> = {};
  for (const segments of found.sort(compareSegments)) {
    result[dirKey(segments)] = loadSync(nodePath.join(root, ...segments), parse);
  }
  return result;
}

function notADirectory(root: string): Error {
  return Object.assign(new Error(`no such config directory: ${root}`), { code: "ENOTDIR" });
}

/** Regular files, and symlinks that point at one. */
async function isFile(file: string): Promise<boolean> {
  return (await fsp.stat(file).catch(() => null))?.isFile() ?? false;
}

function isFileSync(file: string): boolean {
  return fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
}

/** `["guilds", "a.jp"]` -> `"guilds/a"`. Only the last extension is removed. */
function dirKey(segments: string[]): string {
  const last = segments[segments.length - 1]!;
  const ext = nodePath.extname(last);
  return [...segments.slice(0, -1), ext ? last.slice(0, -ext.length) : last].join("/");
}

function compareSegments(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]! ? -1 : 1;
  }
  return a.length - b.length;
}

/** Translate a file-name glob into an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      source += "[^/\\\\]*";
    } else if (char === "?") {
      source += "[^/\\\\]";
    } else if (char === "[" && pattern.indexOf("]", i + 2) !== -1) {
      const close = pattern.indexOf("]", i + 2);
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith("!");
      if (negate) body = body.slice(1);
      source += `[${negate ? "^" : ""}${body.replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  // Match the platform's file-name case sensitivity, as Python's pathlib does.
  return new RegExp(`^${source}$`, process.platform === "win32" ? "i" : "");
}
