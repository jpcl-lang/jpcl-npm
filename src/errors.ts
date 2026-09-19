/**
 * Error hierarchy for the `.jp` configuration format.
 *
 * Every error thrown by this package derives from {@link JPError}, so callers
 * can catch everything with a single `instanceof JPError` check.
 *
 * @module
 */

/** Return the 1-based `[line, column]` of `pos` inside `doc`. */
function lineCol(doc: string, pos: number): [number, number] {
  let line = 1;
  let lineStart = 0;
  for (let i = doc.indexOf("\n"); i !== -1 && i < pos; i = doc.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  // Count code points, not UTF-16 units, so astral characters are one column.
  return [line, codePointLength(doc.slice(lineStart, pos)) + 1];
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** Base class for every error thrown by `jpcl`. */
export class JPError extends Error {
  override name = "JPError";
}

/** Thrown when a value cannot be serialised to `.jp`. */
export class JPEncodeError extends JPError {
  override name = "JPEncodeError";
}

/**
 * Thrown when a `.jp` document is malformed.
 *
 * The message points at the exact offending character, for example:
 *
 * ```
 * servers.jp:4:3: expected ':' after key 'prefix'
 *     prefix "!"
 *       ^
 * ```
 */
export class JPDecodeError extends JPError {
  override name = "JPDecodeError";
  /** The message without the location prefix or source excerpt. */
  readonly rawMessage: string;
  /** The full source text that was being parsed. */
  readonly doc: string;
  /** Zero-based offset (UTF-16 code units) of the error inside `doc`. */
  readonly pos: number;
  /** One-based line number of the error. */
  readonly line: number;
  /** One-based column number of the error, counted in code points. */
  readonly col: number;
  /** Name of the file the text came from, if known. */
  readonly filename: string | null;

  constructor(message: string, doc = "", pos = 0, filename: string | null = null) {
    super(message);
    this.rawMessage = message;
    this.doc = doc;
    this.pos = Math.max(0, Math.min(pos, doc.length));
    this.filename = filename;
    [this.line, this.col] = lineCol(doc, this.pos);
    this.message = this.render();
  }

  private render(): string {
    const parts = [`${this.filename ?? "<string>"}:${this.line}:${this.col}: ${this.rawMessage}`];
    const lines = this.doc.split("\n");
    if (this.line > 0 && this.line <= lines.length && this.doc !== "") {
      const source = lines[this.line - 1]!.replace(/\r$/, "");
      // Keep tabs in the caret prefix so the marker stays aligned.
      const prefix = Array.from(source)
        .slice(0, this.col - 1)
        .map((c) => (c === "\t" ? "\t" : " "))
        .join("");
      parts.push(`    ${source}`, `    ${prefix}^`);
    }
    return parts.join("\n");
  }
}
