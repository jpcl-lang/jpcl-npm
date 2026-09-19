/**
 * Command line interface: `jpcl <command> [files]`.
 *
 * ```
 * check      Validate .jp files and report the first error in each.
 * fmt        Reformat files to canonical style (-w to rewrite in place).
 * get        Print one dotted-path value as JSON.
 * to-json    Convert .jp to JSON.
 * from-json  Convert JSON to .jp.
 * ```
 *
 * @module
 */

import * as fs from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { JPConfig } from "./config.js";
import { ENCODING, JPError, dumps, loads } from "./core.js";
import { dumpSync, loadSync } from "./files.js";
import type { JPObject } from "./values.js";
import { formatFinite, type StringifyOptions } from "./writer.js";
import { version } from "./version.js";

/** Where the CLI reads and writes; swapped out in tests. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): string;
}

const processIO: CliIO = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  readStdin: () => fs.readFileSync(0, ENCODING),
};

type Values = Record<string, string | boolean | undefined>;

interface Command {
  help: string;
  usage: string;
  options: NonNullable<ParseArgsConfig["options"]>;
  /** Positional names; a trailing `...` marks one-or-more. */
  positionals: string[];
  run(values: Values, positionals: string[], io: CliIO): number;
}

class UsageError extends Error {}

const FORMAT_OPTIONS = {
  indent: { type: "string" },
  width: { type: "string" },
  "sort-keys": { type: "boolean" },
} as const;

const FORMAT_HELP = `  --indent N      spaces per level (default 2)
  --width N       column budget for inline arrays (default 88)
  --sort-keys     sort keys alphabetically`;

const COMMANDS: Record<string, Command> = {
  check: {
    help: "validate .jp files",
    usage: `usage: jpcl check [-q] files...

  -q, --quiet     only report errors`,
    options: { quiet: { type: "boolean", short: "q" } },
    positionals: ["files..."],
    run(values, files, io) {
      let failures = 0;
      for (const path of files) {
        try {
          read(path, io);
          if (!values.quiet) io.stdout(`ok  ${path}\n`);
        } catch (error) {
          failures++;
          report(error, io);
        }
      }
      return failures ? 1 : 0;
    },
  },

  fmt: {
    help: "reformat .jp files",
    usage: `usage: jpcl fmt [-w] [--indent N] [--width N] [--sort-keys] files...

  -w, --write     rewrite files in place
${FORMAT_HELP}`,
    options: { write: { type: "boolean", short: "w" }, ...FORMAT_OPTIONS },
    positionals: ["files..."],
    run(values, files, io) {
      const format = formatOptions(values);
      let failures = 0;
      for (const path of files) {
        let data: JPObject;
        let text: string;
        try {
          data = read(path, io);
          text = dumps(data, format);
        } catch (error) {
          failures++;
          report(error, io);
          continue;
        }
        if (values.write && path !== "-") {
          if (fs.readFileSync(path, ENCODING) === text) continue;
          dumpSync(data, path, format);
          io.stderr(`reformatted ${path}\n`);
        } else {
          io.stdout(text);
        }
      }
      return failures ? 1 : 0;
    },
  },

  get: {
    help: "print one value by dotted path",
    usage: `usage: jpcl get [-r] file path

  path            e.g. SERVER_ID.config.disabled_users
  -r, --raw       print strings unquoted`,
    options: { raw: { type: "boolean", short: "r" } },
    positionals: ["file", "path"],
    run(values, [file, path], io) {
      let config: JPConfig;
      try {
        config = new JPConfig(read(file!, io));
      } catch (error) {
        report(error, io);
        return 1;
      }
      const missing = Symbol();
      const value = config.getPath(path!, missing);
      if (value === missing) {
        io.stderr(`no such path: ${path}\n`);
        return 1;
      }
      io.stdout(`${typeof value === "string" && values.raw ? value : toJson(value, 2)}\n`);
      return 0;
    },
  },

  "to-json": {
    help: "convert .jp to JSON",
    usage: `usage: jpcl to-json [-o OUTPUT] [--indent N] file

  -o, --output    write to a file instead of stdout
  --indent N      spaces per level (default 2)`,
    options: { output: { type: "string", short: "o" }, indent: { type: "string" } },
    positionals: ["file"],
    run(values, [file], io) {
      const indent = integer(values, "indent", 2);
      let data: JPObject;
      try {
        data = read(file!, io);
      } catch (error) {
        report(error, io);
        return 1;
      }
      output(values, `${toJson(data, indent)}\n`, io);
      return 0;
    },
  },

  "from-json": {
    help: "convert JSON to .jp",
    usage: `usage: jpcl from-json [-o OUTPUT] [--indent N] [--width N] [--sort-keys] file

  -o, --output    write to a file instead of stdout
${FORMAT_HELP}`,
    options: { output: { type: "string", short: "o" }, ...FORMAT_OPTIONS },
    positionals: ["file"],
    run(values, [file], io) {
      const format = formatOptions(values);
      let text: string;
      try {
        const raw = file === "-" ? io.readStdin() : fs.readFileSync(file!, ENCODING);
        text = dumps(parseJson(raw), format);
      } catch (error) {
        report(error, io, true);
        return 1;
      }
      output(values, text, io);
      return 0;
    },
  },
};

const NAMES = Object.keys(COMMANDS);

const MAIN_USAGE = `usage: jpcl [-h] [--version] {${NAMES.join(",")}} ...

Work with .jp configuration files.

commands:
${NAMES.map((name) => `  ${name.padEnd(12)}${COMMANDS[name]!.help}`).join("\n")}

options:
  -h, --help      show this help message and exit
  --version       show the version and exit
`;

/**
 * Run the `jpcl` command with `argv` (without the `node` and script entries)
 * and return the exit code: `0` on success, `1` when a file fails, `2` for
 * invalid usage.
 */
export function main(argv: readonly string[] = process.argv.slice(2), io: CliIO = processIO): number {
  const [name, ...rest] = argv;
  if (name === undefined) {
    io.stderr(`${MAIN_USAGE.split("\n")[0]}\njpcl: error: a command is required\n`);
    return 2;
  }
  if (name === "-h" || name === "--help") {
    io.stdout(MAIN_USAGE);
    return 0;
  }
  if (name === "--version") {
    io.stdout(`jpcl ${version}\n`);
    return 0;
  }

  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    io.stderr(
      `${MAIN_USAGE.split("\n")[0]}\njpcl: error: invalid command '${name}' (choose from ${NAMES.join(", ")})\n`,
    );
    return 2;
  }

  try {
    const { values, positionals } = parseArgs({
      args: [...rest],
      options: { ...command.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      io.stdout(`${command.usage}\n`);
      return 0;
    }
    checkPositionals(command, positionals);
    return command.run(values, positionals, io);
  } catch (error) {
    const known =
      error instanceof UsageError ||
      (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") === true;
    if (!known) throw error;
    io.stderr(`${command.usage.split("\n")[0]}\njpcl ${name}: error: ${(error as Error).message}\n`);
    return 2;
  }
}

function checkPositionals(command: Command, given: string[]): void {
  const variadic = command.positionals.at(-1)?.endsWith("...") ?? false;
  const required = command.positionals.length;
  const names = command.positionals.map((p) => p.replace("...", ""));
  if (given.length < required) {
    throw new UsageError(`the following arguments are required: ${names.slice(given.length).join(", ")}`);
  }
  if (!variadic && given.length > required) {
    throw new UsageError(`unrecognized arguments: ${given.slice(required).join(" ")}`);
  }
}

function integer(values: Values, name: string, fallback: number): number {
  const raw = values[name];
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new UsageError(`argument --${name}: invalid non-negative int value: '${String(raw)}'`);
  }
  return Number(raw);
}

function formatOptions(values: Values): StringifyOptions {
  return {
    indent: integer(values, "indent", 2),
    width: integer(values, "width", 88),
    sortKeys: values["sort-keys"] === true,
  };
}

/** Load a `.jp` file, or stdin when `path` is `-`. */
function read(path: string, io: CliIO): JPObject {
  if (path === "-") return loads(io.readStdin(), { filename: "<stdin>" });
  return loadSync(path);
}

function output(values: Values, text: string, io: CliIO): void {
  if (typeof values.output === "string") fs.writeFileSync(values.output, text, ENCODING);
  else io.stdout(text);
}

/** Print an expected failure (bad document, unreadable file); rethrow bugs. */
function report(error: unknown, io: CliIO, allowSyntax = false): void {
  const expected =
    error instanceof JPError ||
    (allowSyntax && error instanceof SyntaxError) ||
    typeof (error as { code?: unknown } | null)?.code === "string";
  if (!expected) throw error;
  io.stderr(`${(error as Error).message}\n`);
}

/** `JSON.parse`, keeping integers beyond 2^53 exact as `bigint`. */
function parseJson(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) => {
    const source = context?.source;
    if (typeof value === "number" && !Number.isSafeInteger(value) && source && /^-?\d+$/.test(source)) {
      return BigInt(source);
    }
    return value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

/**
 * Render a value as indented JSON. Unlike `JSON.stringify` this writes a
 * `bigint` as a plain integer and non-finite numbers as `NaN` / `Infinity`,
 * matching Python's `json.dumps`, so nothing a `.jp` file holds is lost.
 */
export function toJson(value: unknown, indent: number, level = 0): string {
  if (value === null || value === undefined) return "null";
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      if (Number.isNaN(value)) return "NaN";
      if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
      return formatFinite(value);
    case "boolean":
    case "string":
      return JSON.stringify(value);
  }
  const inner = `\n${" ".repeat(indent * (level + 1))}`;
  const outer = `\n${" ".repeat(indent * level)}`;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[${inner}${value.map((v) => toJson(v, indent, level + 1)).join(`,${inner}`)}${outer}]`;
  }
  const entries = Object.entries(value as object).filter(([, v]) => v !== undefined);
  if (!entries.length) return "{}";
  const body = entries.map(([k, v]) => `${JSON.stringify(k)}: ${toJson(v, indent, level + 1)}`);
  return `{${inner}${body.join(`,${inner}`)}${outer}}`;
}
