/**
 * Character-level scanning primitives for the `.jp` format.
 *
 * The scanner owns the cursor and every *lexical* concern: whitespace,
 * comments, quoted strings, and the interpretation of bare (unquoted) tokens.
 * It knows nothing about the grammar -- that lives in `parser.ts`.
 *
 * The format is deliberately context sensitive (`[` opens a section header at
 * the top level but an array everywhere else), so there is no standalone token
 * stream; the parser drives the scanner directly.
 *
 * @module
 */

import { JPDecodeError } from "./errors.js";

/** How integers are represented once parsed. */
export type IntegerMode = "auto" | "bigint" | "number";

/** Whitespace that never terminates a line. */
const INLINE_SPACE = new Set([" ", "\t", "\f", "\v"]);

/** Characters that end an unquoted value. */
export const VALUE_END = new Set([",", "}", "]", "\r", "\n", "#"]);

/**
 * Characters that end an unquoted key. A key normally ends at its colon; the
 * others are listed so that a missing colon is reported at the character that
 * caused it rather than at the end of the line. A bare key may contain spaces
 * (`my key: 1`) but not brackets or quotes -- quote the key for those.
 */
export const KEY_END = new Set([":", ",", "{", "}", "[", "]", '"', "'", "\r", "\n", "#"]);

/** Characters that end one segment of a `[dotted.header]`. */
export const HEADER_END = new Set([".", "]", "\r", "\n", "#"]);

const ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'",
  "\\": "\\",
  "/": "/",
  "0": "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

const HEX_WIDTH: Record<string, number> = { x: 2, u: 4, U: 8 };

const HEX_DIGITS = /^[0-9a-fA-F]+$/;

/**
 * Bare words with a fixed meaning. Matched case-insensitively so that both
 * JSON (`true`/`null`) and Python (`True`/`None`) spellings work. Deliberately
 * excludes `yes`/`no`/`on`/`off`: silently turning those into booleans
 * surprises people more often than it helps.
 */
export const KEYWORDS: ReadonlyMap<string, boolean | number | null> = new Map<
  string,
  boolean | number | null
>([
  ["true", true],
  ["false", false],
  ["null", null],
  ["none", null],
  ["nil", null],
  ["nan", NaN],
  ["inf", Infinity],
  ["infinity", Infinity],
  ["+inf", Infinity],
  ["+infinity", Infinity],
  ["-inf", -Infinity],
  ["-infinity", -Infinity],
]);

const DEC_INT = /^[+-]?\d+(?:_\d+)*$/;
const RADIX_INT = /^([+-]?)0(?:[xX](?:_?[0-9a-fA-F])+|[oO](?:_?[0-7])+|[bB](?:_?[01])+)$/;
const FLOAT =
  /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const SIGNED_NON_FINITE = /^[+-]?(?:nan|inf|infinity)$/i;

function toInteger(text: string, mode: IntegerMode): number | bigint {
  const negative = text.startsWith("-");
  const body = text.replace(/^[+-]/, "").replaceAll("_", "");
  // BigInt() accepts 0x/0o/0b prefixes but not a sign alongside them.
  const big = negative ? -BigInt(body) : BigInt(body);
  if (mode === "bigint") return big;
  const small = Number(big);
  if (mode === "number" || Number.isSafeInteger(small)) return small;
  return big;
}

/**
 * Convert `text` to a number (or bigint), or return `undefined` if it is not
 * numeric. Accepts underscore separators, an optional sign, and the `0x` /
 * `0o` / `0b` radix prefixes, mirroring both TOML and Python literals.
 */
function parseNumber(text: string, mode: IntegerMode): number | bigint | undefined {
  if (DEC_INT.test(text) || RADIX_INT.test(text)) return toInteger(text, mode);
  if (FLOAT.test(text)) return Number(text.replaceAll("_", ""));
  if (SIGNED_NON_FINITE.test(text)) {
    const word = text.replace(/^[+-]/, "").toLowerCase();
    if (word === "nan") return NaN;
    return text.startsWith("-") ? -Infinity : Infinity;
  }
  return undefined;
}

/**
 * Interpret an unquoted token as a value.
 *
 * Resolution order is keyword, then number, then plain string. An empty or
 * whitespace-only token means "no value" and yields `null`, which is what makes
 * `disabled_channels:,` legal.
 */
export function interpretBare(
  text: string,
  mode: IntegerMode = "auto",
): string | number | bigint | boolean | null {
  const token = text.trim();
  if (!token) return null;
  const keyword = KEYWORDS.get(token.toLowerCase());
  if (keyword !== undefined) return keyword;
  return parseNumber(token, mode) ?? token;
}

/** Render a string the way Python's `repr()` does, for error messages. */
export function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === quote || char === "\\") out += `\\${char}`;
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return out + quote;
}

/** A cursor over the source text with lexical helpers. */
export class Scanner {
  readonly text: string;
  readonly filename: string | null;
  pos = 0;

  constructor(text: string, filename: string | null = null) {
    // A UTF-8 BOM is common in files written by Windows editors.
    this.text = text.replace(/^﻿+/, "");
    this.filename = filename;
  }

  // -- cursor ------------------------------------------------------------

  /** Whether the cursor has reached the end of the document. */
  get eof(): boolean {
    return this.pos >= this.text.length;
  }

  /** Return the character at `pos + offset`, or `undefined` past the end. */
  peek(offset = 0): string | undefined {
    const index = this.pos + offset;
    return index >= 0 && index < this.text.length ? this.text[index] : undefined;
  }

  /** Move the cursor forward by `count` characters. */
  advance(count = 1): void {
    this.pos += count;
  }

  /** Build a {@link JPDecodeError} anchored at `pos` (default: the cursor). */
  error(message: string, pos: number = this.pos): JPDecodeError {
    return new JPDecodeError(message, this.text, pos, this.filename);
  }

  /** Describe the current character for use in an error message. */
  describeHere(): string {
    const char = this.peek();
    if (char === undefined) return "end of file";
    if (char === "\r" || char === "\n") return "end of line";
    return repr(char);
  }

  // -- trivia ------------------------------------------------------------

  /** Skip spaces, tabs and a `#` comment -- but never a line break. */
  skipInline(): void {
    this.skip(false);
  }

  /** Skip all whitespace (line breaks included) and comments. */
  skipIgnorable(): void {
    this.skip(true);
  }

  private skip(newlines: boolean): void {
    const { text } = this;
    const end = text.length;
    let i = this.pos;
    while (i < end) {
      const char = text[i]!;
      if (INLINE_SPACE.has(char) || (newlines && (char === "\r" || char === "\n"))) {
        i++;
      } else if (char === "#") {
        while (i < end && text[i] !== "\r" && text[i] !== "\n") i++;
      } else {
        break;
      }
    }
    this.pos = i;
  }

  // -- literals ----------------------------------------------------------

  /**
   * Read a quoted string at the cursor and return its decoded value.
   *
   * Single and double quotes behave identically and both honour backslash
   * escapes. A backslash at end of line continues the string onto the next
   * line, swallowing the following indentation.
   */
  scanString(): string {
    const start = this.pos;
    const { text } = this;
    const end = text.length;
    const quote = text[start];
    let i = start + 1;
    let out = "";
    let literalFrom = i;

    while (true) {
      if (i >= end) throw this.error("unterminated string literal", start);
      const char = text[i];
      if (char === quote) {
        this.pos = i + 1;
        return out + text.slice(literalFrom, i);
      }
      if (char === "\r" || char === "\n") {
        throw this.error("unterminated string literal (use \\n for a line break)", start);
      }
      if (char !== "\\") {
        i++;
        continue;
      }

      out += text.slice(literalFrom, i);
      const escapeAt = i;
      i++;
      if (i >= end) throw this.error("unterminated escape sequence", escapeAt);
      const marker = text[i]!;

      if (Object.hasOwn(ESCAPES, marker)) {
        out += ESCAPES[marker];
        i++;
      } else if (Object.hasOwn(HEX_WIDTH, marker)) {
        const [decoded, next] = this.scanHexEscape(i, escapeAt);
        out += decoded;
        i = next;
      } else if (marker === "\r" || marker === "\n") {
        // Backslash-newline: continue the string, eating the indent.
        i++;
        if (marker === "\r" && text[i] === "\n") i++;
        while (i < end && INLINE_SPACE.has(text[i]!)) i++;
      } else {
        throw this.error(`invalid escape sequence '\\${marker}'`, escapeAt);
      }
      literalFrom = i;
    }
  }

  /** Decode `\xNN` / `\uNNNN` / `\UNNNNNNNN` starting at `markerAt`. */
  private scanHexEscape(markerAt: number, escapeAt: number): [string, number] {
    const { text } = this;
    const marker = text[markerAt]!;
    const width = HEX_WIDTH[marker]!;
    const digits = text.slice(markerAt + 1, markerAt + 1 + width);
    if (digits.length < width || !HEX_DIGITS.test(digits)) {
      throw this.error(`'\\${marker}' escape needs ${width} hex digits`, escapeAt);
    }
    let code = parseInt(digits, 16);
    let i = markerAt + 1 + width;

    // Recombine a UTF-16 surrogate pair, as JSON encoders emit them.
    if (marker === "u" && code >= 0xd800 && code <= 0xdbff && text.slice(i, i + 2) === "\\u") {
      const lowDigits = text.slice(i + 2, i + 6);
      if (lowDigits.length === 4 && HEX_DIGITS.test(lowDigits)) {
        const low = parseInt(lowDigits, 16);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i += 6;
        }
      }
    }

    if (code >= 0xd800 && code <= 0xdfff) {
      throw this.error(`'\\${marker}${digits}' is an unpaired surrogate`, escapeAt);
    }
    if (code > 0x10ffff) {
      throw this.error(`'\\${marker}${digits}' is outside the Unicode range`, escapeAt);
    }
    return [String.fromCodePoint(code), i];
  }

  /** Consume characters up to (not including) any of `terminators`. */
  scanUntil(terminators: ReadonlySet<string>): string {
    const { text } = this;
    const end = text.length;
    let i = this.pos;
    while (i < end && !terminators.has(text[i]!)) i++;
    const raw = text.slice(this.pos, i);
    this.pos = i;
    return raw;
  }
}
