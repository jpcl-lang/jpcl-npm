/**
 * The runtime-agnostic half of `jpml`: parsing and serialising strings, with
 * no filesystem access. Import `jpml/core` in browsers, workers and edge
 * runtimes; import `jpml` in Node, Bun or Deno for the file helpers and
 * {@link JPConfig}.
 *
 * @module
 */

import { parse, type ParseOptions } from "./parser.js";
import { dumps as write, type StringifyOptions } from "./writer.js";
import type { JPObject } from "./values.js";

export { JPDecodeError, JPEncodeError, JPError } from "./errors.js";
export { MAX_DEPTH, type DuplicateKeys, type ParseOptions } from "./parser.js";
export type { IntegerMode } from "./scanner.js";
export type { StringifyOptions } from "./writer.js";
export type { JPObject, JPValue } from "./values.js";

/** Conventional file extension. */
export const SUFFIX = ".jp";

/** `.jp` files are always UTF-8. */
export const ENCODING = "utf-8";

/**
 * Parse `.jp` text into a plain object.
 *
 * @throws {JPDecodeError} If the document is malformed.
 */
export function loads(text: string, options?: ParseOptions): JPObject {
  return parse(text, options);
}

/**
 * Serialise an object (or `Map`) to `.jp` text.
 *
 * @throws {JPEncodeError} If the value cannot be represented.
 */
export function dumps(value: unknown, options?: StringifyOptions): string {
  return write(value, options);
}

export { loads as parse, dumps as stringify };
