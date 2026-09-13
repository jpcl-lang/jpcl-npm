/**
 * Recursive-descent parser for the `.jp` format.
 *
 * ```
 * document   := entry* section*
 * section    := '[' key ('.' key)* ']' NEWLINE entry*
 * entry      := key ':' value? separator
 * value      := object | array | string | number | keyword | bare
 * object     := '{' entry* '}'
 * array      := '[' (value separator)* ']'
 * separator  := ',' | NEWLINE | lookahead('}' | ']' | EOF)
 * ```
 *
 * Two rules keep the format unambiguous:
 *
 * - `[` starts a **section header** only at the top level of the document.
 *   Anywhere a value is expected it starts an **array**.
 * - A value must begin on the same line as its `:`. That is what lets
 *   `disabled_channels:,` mean "this key exists and has no value" instead of
 *   swallowing the next line.
 *
 * @module
 */

import {
  HEADER_END,
  KEY_END,
  VALUE_END,
  Scanner,
  interpretBare,
  repr,
  type IntegerMode,
} from "./scanner.js";
import { isPlainObject, setOwn, type JPObject, type JPValue } from "./values.js";

/**
 * How deep `{` / `[` nesting may go before we refuse, so that hostile or
 * corrupt input throws a clean error instead of overflowing the stack.
 */
export const MAX_DEPTH = 200;

/** What to do when a key appears twice in the same mapping. */
export type DuplicateKeys = "error" | "first" | "last";

const DUPLICATE_POLICIES: readonly DuplicateKeys[] = ["error", "first", "last"];

export interface ParseOptions {
  /** Name used in error messages. */
  filename?: string | null;
  /**
   * `"error"` (default) rejects a repeated key, `"first"` keeps the original,
   * `"last"` keeps the later one.
   */
  duplicateKeys?: DuplicateKeys;
  /**
   * `"auto"` (default) parses integers as `number` while they are safe
   * integers and as `bigint` beyond that, so large IDs such as Discord
   * snowflakes keep every digit. `"bigint"` always produces `bigint`;
   * `"number"` always produces `number`, accepting precision loss.
   */
  integers?: IntegerMode;
}

/** Parses one `.jp` document into plain objects and arrays. */
export class Parser {
  private readonly scanner: Scanner;
  private readonly duplicateKeys: DuplicateKeys;
  private readonly integers: IntegerMode;
  private depth = 0;
  /** Section paths opened by an explicit header, to detect `[a]` twice. */
  private readonly defined = new Set<string>();

  constructor(text: string, options: ParseOptions = {}) {
    const { filename = null, duplicateKeys = "error", integers = "auto" } = options;
    if (!DUPLICATE_POLICIES.includes(duplicateKeys)) {
      throw new RangeError(
        `duplicateKeys must be one of ${DUPLICATE_POLICIES.map(repr).join(", ")}, got ${String(duplicateKeys)}`,
      );
    }
    if (!["auto", "bigint", "number"].includes(integers)) {
      throw new RangeError(`integers must be 'auto', 'bigint' or 'number', got ${String(integers)}`);
    }
    this.scanner = new Scanner(text, filename);
    this.duplicateKeys = duplicateKeys;
    this.integers = integers;
  }

  // -- entry point -------------------------------------------------------

  /** Parse the whole document and return its root object. */
  parse(): JPObject {
    const { scanner } = this;
    const root: JPObject = {};
    let current = root;

    while (true) {
      scanner.skipIgnorable();
      if (scanner.eof) return root;
      if (scanner.peek() === "[") {
        current = this.parseHeader(root);
        continue;
      }
      const [key, value, keyPos] = this.parseEntry();
      this.store(current, key, value, keyPos);
      this.consumeSeparator(null);
    }
  }

  // -- sections ----------------------------------------------------------

  /** Parse `[a.b.c]` and return the object its entries belong to. */
  private parseHeader(root: JPObject): JPObject {
    const { scanner } = this;
    const start = scanner.pos;
    scanner.advance(); // '['

    const path: string[] = [];
    let pendingDot = false;
    while (true) {
      scanner.skipInline();
      let char = scanner.peek();
      if (char === undefined || char === "\r" || char === "\n") {
        throw scanner.error("unterminated section header", start);
      }
      if (char === "]") {
        if (path.length === 0) throw scanner.error("section header cannot be empty", start);
        if (pendingDot) throw scanner.error("section header segment cannot be empty");
        scanner.advance();
        break;
      }
      if (char === '"' || char === "'") {
        path.push(scanner.scanString());
      } else {
        const segment = scanner.scanUntil(HEADER_END).trim();
        if (!segment) throw scanner.error("section header segment cannot be empty");
        path.push(segment);
      }
      pendingDot = false;

      scanner.skipInline();
      char = scanner.peek();
      if (char === ".") {
        scanner.advance();
        pendingDot = true;
        continue;
      }
      if (char === "]") {
        scanner.advance();
        break;
      }
      if (char === undefined || char === "\r" || char === "\n") {
        throw scanner.error("unterminated section header", start);
      }
      throw scanner.error(
        `expected '.' or ']' in section header, found ${scanner.describeHere()}`,
      );
    }

    scanner.skipInline();
    const char = scanner.peek();
    if (char !== undefined && char !== "\r" && char !== "\n") {
      throw scanner.error(`unexpected ${scanner.describeHere()} after section header`);
    }

    return this.openSection(root, path, start);
  }

  /** Create or reuse the nested object addressed by `path`. */
  private openSection(root: JPObject, path: string[], start: number): JPObject {
    const { scanner } = this;
    const id = JSON.stringify(path);
    if (this.defined.has(id) && this.duplicateKeys === "error") {
      throw scanner.error(`section '[${path.join(".")}]' is defined twice`, start);
    }
    this.defined.add(id);

    let node = root;
    for (const [depth, part] of path.entries()) {
      if (!Object.hasOwn(node, part)) {
        const child: JPObject = {};
        setOwn(node, part, child);
        node = child;
        continue;
      }
      const existing = node[part];
      if (!isPlainObject(existing)) {
        throw scanner.error(
          `cannot open section '[${path.join(".")}]': ` +
            `'${path.slice(0, depth + 1).join(".")}' is already a non-section value`,
          start,
        );
      }
      node = existing;
    }
    return node;
  }

  // -- entries -----------------------------------------------------------

  /** Parse `key: value` and return `[key, value, keyPosition]`. */
  private parseEntry(): [string, JPValue, number] {
    const { scanner } = this;
    scanner.skipInline();
    const keyPos = scanner.pos;
    const key = this.parseKey();

    scanner.skipInline();
    if (scanner.peek() !== ":") {
      throw scanner.error(`expected ':' after key ${repr(key)}, found ${scanner.describeHere()}`);
    }
    scanner.advance();
    return [key, this.parseOptionalValue(), keyPos];
  }

  /** Read a quoted or bare key. */
  private parseKey(): string {
    const { scanner } = this;
    const char = scanner.peek();
    if (char === undefined) throw scanner.error("expected a key, found end of file");
    if (char === '"' || char === "'") return scanner.scanString();
    if (char === "}" || char === "]") throw scanner.error(`unexpected ${scanner.describeHere()}`);

    const start = scanner.pos;
    const key = scanner.scanUntil(KEY_END).trim();
    if (!key) throw scanner.error(`expected a key, found ${scanner.describeHere()}`, start);
    return key;
  }

  /** Read the value after a `:`, or `null` when the value is empty. */
  private parseOptionalValue(): JPValue {
    const { scanner } = this;
    scanner.skipInline();
    const char = scanner.peek();
    if (char === undefined || char === "," || char === "\r" || char === "\n") return null;
    return this.parseValue();
  }

  /** Read any value at the cursor. */
  private parseValue(): JPValue {
    const { scanner } = this;
    const char = scanner.peek();
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'") return scanner.scanString();
    return interpretBare(scanner.scanUntil(VALUE_END), this.integers);
  }

  // -- containers --------------------------------------------------------

  private enter(start: number): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw this.scanner.error(`nesting deeper than ${MAX_DEPTH} levels`, start);
    }
  }

  /** Parse `{ key: value, ... }`. */
  private parseObject(): JPObject {
    const { scanner } = this;
    const start = scanner.pos;
    this.enter(start);
    scanner.advance(); // '{'
    const obj: JPObject = {};

    while (true) {
      scanner.skipIgnorable();
      const char = scanner.peek();
      if (char === undefined) throw scanner.error("unterminated object: missing '}'", start);
      if (char === "}") {
        scanner.advance();
        this.depth--;
        return obj;
      }
      if (char === ",") {
        // Tolerate stray or repeated separators.
        scanner.advance();
        continue;
      }
      const [key, value, keyPos] = this.parseEntry();
      this.store(obj, key, value, keyPos);
      this.consumeSeparator("}");
    }
  }

  /** Parse `[ value, ... ]`. */
  private parseArray(): JPValue[] {
    const { scanner } = this;
    const start = scanner.pos;
    this.enter(start);
    scanner.advance(); // '['
    const items: JPValue[] = [];

    while (true) {
      scanner.skipIgnorable();
      const char = scanner.peek();
      if (char === undefined) throw scanner.error("unterminated array: missing ']'", start);
      if (char === "]") {
        scanner.advance();
        this.depth--;
        return items;
      }
      if (char === ",") {
        scanner.advance();
        continue;
      }
      if (char === "}") throw scanner.error("unterminated array: found '}' before ']'", start);
      items.push(this.parseValue());
      this.consumeSeparator("]");
    }
  }

  // -- separators and storage -------------------------------------------

  /** Require a `,`, a line break, or the closing bracket after a value. */
  private consumeSeparator(closing: "}" | "]" | null): void {
    const { scanner } = this;
    scanner.skipInline();
    const char = scanner.peek();
    if (char === undefined || char === "\r" || char === "\n") return;
    if (char === ",") {
      scanner.advance();
      return;
    }
    if (closing !== null && char === closing) return;
    if (closing === null && char === "[") {
      // A section header always starts its own line; reaching one here means
      // the previous entry never ended.
      throw scanner.error("expected a line break before a section header");
    }
    const expected =
      closing === null ? "',' or a line break" : `',', a line break or '${closing}'`;
    throw scanner.error(`expected ${expected} after value, found ${scanner.describeHere()}`);
  }

  /** Insert `key` into `target`, applying the duplicate-key policy. */
  private store(target: JPObject, key: string, value: JPValue, keyPos: number): void {
    if (Object.hasOwn(target, key)) {
      if (this.duplicateKeys === "error") {
        throw this.scanner.error(`duplicate key ${repr(key)}`, keyPos);
      }
      if (this.duplicateKeys === "first") return;
    }
    setOwn(target, key, value);
  }
}

/**
 * Parse `text` as a `.jp` document.
 *
 * @throws {JPDecodeError} If the document is malformed.
 */
export function parse(text: string, options?: ParseOptions): JPObject {
  return new Parser(text, options).parse();
}
