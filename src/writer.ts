/**
 * Serialiser that turns JavaScript values back into `.jp` source.
 *
 * The output style is fixed and deterministic, so a file stays stable under
 * repeated round-trips:
 *
 * - Every top-level object becomes a `[SECTION]`; sections are separated by a
 *   blank line.
 * - Section entries sit one per line with no separating commas.
 * - Nested objects always expand across lines with `indent` spaces per level
 *   and comma-separated entries; `{}` is the only inline form.
 * - Arrays stay on one line while they fit inside `width`; otherwise they break
 *   one element per line.
 * - `null` is written as an empty value (`key:`) inside objects, and as `null`
 *   inside arrays, since an array element cannot be empty.
 *
 * @module
 */

import { JPEncodeError } from "./errors.js";
import { isPlainObject } from "./values.js";

export interface StringifyOptions {
  /** Spaces per nesting level. Default `2`. */
  indent?: number;
  /** Column budget used to decide whether an array stays inline. Default `88`. */
  width?: number;
  /** Sort keys by code point instead of keeping insertion order. */
  sortKeys?: boolean;
  /** Escape non-ASCII characters instead of writing them literally. */
  ensureAscii?: boolean;
  /**
   * Called for values of otherwise unsupported types (a `Date`, a class
   * instance, ...). It must return something serialisable, for example
   * `(value) => value instanceof Date ? value.toISOString() : String(value)`.
   */
  default?: (value: unknown) => unknown;
}

/** Keys matching this are written without quotes. */
const BARE_KEY = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

const STRING_ESCAPES: Record<string, string> = {
  "\\": "\\\\",
  '"': '\\"',
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

const hex4 = (code: number): string => `\\u${code.toString(16).padStart(4, "0")}`;

/** Return the escaped form of one character (one code point). */
function escapeChar(char: string): string {
  const simple = STRING_ESCAPES[char];
  if (simple !== undefined) return simple;
  const code = char.codePointAt(0)!;
  if (code > 0xffff) {
    // Encode astral characters as a UTF-16 surrogate pair.
    const offset = code - 0x10000;
    return hex4(0xd800 + (offset >> 10)) + hex4(0xdc00 + (offset & 0x3ff));
  }
  return hex4(code);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "object" || typeof value === "function") {
    return (value as { constructor?: { name?: string } }).constructor?.name || typeof value;
  }
  return typeof value;
}

/** Renders values using one fixed set of formatting options. */
class Writer {
  private readonly indent: string;
  private readonly width: number;
  private readonly sortKeys: boolean;
  private readonly ensureAscii: boolean;
  private readonly fallback: ((value: unknown) => unknown) | undefined;
  /** Containers currently being rendered, to catch cycles. */
  private readonly active = new Set<object>();

  constructor(options: StringifyOptions) {
    const { indent = 2, width = 88, sortKeys = false, ensureAscii = false } = options;
    if (!Number.isInteger(indent) || indent < 0) {
      throw new RangeError("indent must be an integer >= 0");
    }
    this.indent = " ".repeat(indent);
    this.width = width;
    this.sortKeys = sortKeys;
    this.ensureAscii = ensureAscii;
    this.fallback = options.default;
  }

  // -- documents ---------------------------------------------------------

  /** Render a whole document. */
  document(mapping: object): string {
    const preamble: string[] = [];
    const blocks: string[] = [];

    for (const [key, value] of this.items(mapping)) {
      if (isMapping(value)) {
        const body = this.guard(value, () =>
          this.items(value).map(([k, v]) => this.entry(k, v, 0)),
        );
        blocks.push([`[${this.formatKey(key)}]`, ...body].join("\n"));
      } else {
        // Anything after a header would be read back as part of that section,
        // so scalar roots are hoisted above the first one.
        preamble.push(this.entry(key, value, 0));
      }
    }

    if (preamble.length) blocks.unshift(preamble.join("\n"));
    return blocks.length ? blocks.join("\n\n") + "\n" : "";
  }

  // -- pieces ------------------------------------------------------------

  /** Render one `key: value` line (possibly spanning several lines). */
  private entry(key: string, value: unknown, level: number): string {
    const prefix = `${this.indent.repeat(level)}${this.formatKey(key)}:`;
    if (value === null) return prefix;
    return `${prefix} ${this.render(value, level, codePointLength(prefix) + 1)}`;
  }

  /** Render a key, quoting it only when it is not a bare word. */
  private formatKey(key: string): string {
    return BARE_KEY.test(key) ? key : this.formatString(key);
  }

  /** Render a string literal with the minimum necessary escaping. */
  private formatString(value: string): string {
    let out = '"';
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (
        Object.hasOwn(STRING_ESCAPES, char) ||
        code < 0x20 ||
        code === 0x7f ||
        (this.ensureAscii && code > 0x7e) ||
        (code >= 0xd800 && code <= 0xdfff) // a lone surrogate
      ) {
        out += escapeChar(char);
      } else {
        out += char;
      }
    }
    return out + '"';
  }

  /** Render any value; `column` is where it starts on the current line. */
  private render(value: unknown, level: number, column: number): string {
    if (value === null || value === undefined) return "null";
    switch (typeof value) {
      case "boolean":
        return value ? "true" : "false";
      case "string":
        return this.formatString(value);
      case "bigint":
        return value.toString();
      case "number":
        return formatNumber(value);
    }
    if (isMapping(value)) return this.renderObject(value, level);
    if (Array.isArray(value)) return this.renderArray(value, level, column);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      throw new JPEncodeError(
        "binary data has no .jp representation; decode or encode it to a string first",
      );
    }
    return this.renderDefault(value, level, column);
  }

  /** Convert an unsupported type through the `default` hook. */
  private renderDefault(value: unknown, level: number, column: number): string {
    if (this.fallback === undefined) {
      throw new JPEncodeError(
        `value of type '${typeName(value)}' is not serialisable to .jp; pass default to convert it`,
      );
    }
    const converted = this.fallback(value);
    if (converted === value || (converted !== null && typeName(converted) === typeName(value))) {
      throw new JPEncodeError(`default() returned an unconverted '${typeName(value)}'`);
    }
    return this.render(converted, level, column);
  }

  // -- containers --------------------------------------------------------

  /** Render `{...}`; always multi-line unless empty. */
  private renderObject(mapping: object, level: number): string {
    return this.guard(mapping, () => {
      const items = this.items(mapping);
      if (!items.length) return "{}";
      const body = items.map(([k, v]) => this.entry(k, v, level + 1)).join(",\n");
      return `{\n${body}\n${this.indent.repeat(level)}}`;
    });
  }

  /** Render `[...]`, inline when it fits on the line. */
  private renderArray(values: readonly unknown[], level: number, column: number): string {
    return this.guard(values, () => {
      const parts = Array.from(values, (v) => this.render(v, level + 1, column));
      if (!parts.length) return "[]";
      const inline = `[${parts.join(", ")}]`;
      if (!inline.includes("\n") && column + codePointLength(inline) <= this.width) {
        return inline;
      }
      const pad = this.indent.repeat(level + 1);
      const body = parts.map((part) => pad + part).join(",\n");
      return `[\n${body}\n${this.indent.repeat(level)}]`;
    });
  }

  // -- helpers -----------------------------------------------------------

  /**
   * Return `[key, value]` pairs with keys normalised to strings. Properties
   * whose value is `undefined` are skipped, as `JSON.stringify` does.
   */
  private items(mapping: object): [string, unknown][] {
    const pairs: [string, unknown][] =
      mapping instanceof Map
        ? Array.from(mapping, ([k, v]) => [coerceKey(k), v])
        : Object.entries(mapping);
    const items = pairs.filter(([, v]) => v !== undefined);
    if (this.sortKeys) items.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return items;
  }

  private guard<T>(container: object, render: () => T): T {
    if (this.active.has(container)) throw new JPEncodeError("circular reference detected");
    this.active.add(container);
    try {
      return render();
    } finally {
      this.active.delete(container);
    }
  }
}

/** Whether `value` is rendered as an object: a plain object or a `Map`. */
function isMapping(value: unknown): value is object {
  return isPlainObject(value) || value instanceof Map;
}

/** Render a number, including the non-finite literals. */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  return formatFinite(value);
}

/**
 * Render a finite number exactly as jpml-py does, so both writers produce the
 * same bytes: a whole number below 1e16 is written as an integer, anything else
 * as Python's `repr(float)` -- the shortest round-tripping digits, in
 * scientific notation when the exponent is below -4 or at least 16
 * (`1e-05`, `1e+16`), and in positional notation otherwise.
 */
export function formatFinite(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
  // toExponential() with no argument gives the shortest unique digits.
  const [mantissa, exponentText] = value.toExponential().split("e") as [string, string];
  const exponent = Number(exponentText);
  const digits = mantissa.replace("-", "").replace(".", "");
  const sign = value < 0 ? "-" : "";

  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : "";
    const expSign = exponent < 0 ? "-" : "+";
    return `${sign}${digits[0]}${fraction}e${expSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

/**
 * Normalise a `Map` key to a string. Integer keys are common (Discord
 * snowflakes, for instance) and convert unambiguously, so they are accepted;
 * anything else is rejected rather than silently stringified.
 */
function coerceKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (typeof key === "bigint" || (typeof key === "number" && Number.isInteger(key))) {
    return String(key);
  }
  throw new JPEncodeError(`keys must be strings (or integers), got '${typeName(key)}'`);
}

/**
 * Serialise `value` to `.jp` source text.
 *
 * @param value The object (or `Map`) to serialise. Every top-level object
 *   value becomes a `[SECTION]`.
 * @returns The document text, ending with a newline (an empty object gives `""`).
 * @throws {JPEncodeError} If `value` or one of its members cannot be represented.
 */
export function dumps(value: unknown, options: StringifyOptions = {}): string {
  if (!isMapping(value)) {
    throw new JPEncodeError(
      `the top level of a .jp document must be an object, got '${typeName(value)}'`,
    );
  }
  return new Writer(options).document(value);
}
