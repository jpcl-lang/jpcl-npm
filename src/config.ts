/**
 * {@link JPConfig}: a mutable `.jp` document that remembers the file it came
 * from.
 *
 * @module
 */

import * as fs from "node:fs";

import { dumps, loads } from "./core.js";
import { dump, dumpSync, load, loadSync, toPath, type PathLike } from "./files.js";
import type { ParseOptions } from "./parser.js";
import { isPlainObject, setOwn } from "./values.js";
import type { StringifyOptions } from "./writer.js";

/** Read and write options a config remembers for `reload()` and `save()`. */
export type ConfigOptions = Omit<ParseOptions, "filename"> & StringifyOptions;

export interface JPConfigInit extends ConfigOptions {
  /** File this config is bound to, used by `save()` and `reload()`. */
  path?: PathLike | null;
}

export interface JPConfigLoadOptions extends ConfigOptions {
  /**
   * Return an empty config bound to the path instead of throwing when the file
   * does not exist yet.
   */
  missingOk?: boolean;
}

export interface SaveOptions extends StringifyOptions {
  /** Write via a temporary file and rename. Default `true`. */
  atomic?: boolean;
}

const READ_OPTIONS = ["duplicateKeys", "integers"] as const;
const WRITE_OPTIONS = ["indent", "width", "sortKeys", "ensureAscii", "default"] as const;

/** Config data is dynamic by nature, like the result of `JSON.parse`. */
type Data = Record<string, any>;

/**
 * A mutable `.jp` document that remembers where it came from.
 *
 * ```ts
 * const cfg = await JPConfig.load("data/servers.jp", { missingOk: true });
 * cfg.getPath("SERVER_ID.config.disabled_users", []);
 * cfg.setPath("SERVER_ID.prefix", "!");
 * await cfg.save();
 * ```
 */
export class JPConfig implements Iterable<[string, any]> {
  /** File this config is bound to, if any. */
  path: string | null;
  #data: Data;
  readonly #readOptions: Omit<ParseOptions, "filename">;
  readonly #writeOptions: StringifyOptions;

  /**
   * @param data Initial object; copied shallowly, not aliased.
   * @param init The bound `path`, plus any parse or stringify option to
   *   remember for `reload()` and `save()`.
   */
  constructor(data?: Record<string, unknown> | null, init: JPConfigInit = {}) {
    const { path = null, ...options } = init;
    const known: readonly string[] = [...READ_OPTIONS, ...WRITE_OPTIONS];
    const unknown = Object.keys(options).filter((key) => !known.includes(key));
    if (unknown.length) throw new TypeError(`unknown option(s): ${unknown.sort().join(", ")}`);

    this.#data = {};
    for (const [key, value] of Object.entries(data ?? {})) setOwn(this.#data, key, value);
    this.path = path === null ? null : toPath(path);
    this.#readOptions = pick(options, READ_OPTIONS);
    this.#writeOptions = pick(options, WRITE_OPTIONS);
  }

  // -- constructors ------------------------------------------------------

  /** Read `path` into a new config. */
  static async load(path: PathLike, options: JPConfigLoadOptions = {}): Promise<JPConfig> {
    const { missingOk = false, ...rest } = options;
    try {
      return new JPConfig(await load(path, pick(rest, READ_OPTIONS)), { ...rest, path });
    } catch (error) {
      if (missingOk && isMissing(error)) return new JPConfig(null, { ...rest, path });
      throw error;
    }
  }

  /** Synchronous {@link JPConfig.load}. */
  static loadSync(path: PathLike, options: JPConfigLoadOptions = {}): JPConfig {
    const { missingOk = false, ...rest } = options;
    if (missingOk && !fs.existsSync(toPath(path))) return new JPConfig(null, { ...rest, path });
    return new JPConfig(loadSync(path, pick(rest, READ_OPTIONS)), { ...rest, path });
  }

  /** Parse `text` into a new config, optionally bound to `path`. */
  static loads(text: string, init: JPConfigInit = {}): JPConfig {
    const filename = init.path == null ? null : toPath(init.path);
    return new JPConfig(loads(text, { ...pick(init, READ_OPTIONS), filename }), init);
  }

  // -- map-like access ---------------------------------------------------

  /**
   * The live top-level object. Reading and writing through it is the same as
   * using the config itself: `cfg.data.SERVER_ID.prefix = "!"`.
   */
  get data(): Data {
    return this.#data;
  }

  /** Number of top-level keys. */
  get size(): number {
    return Object.keys(this.#data).length;
  }

  get(key: string): any {
    return Object.hasOwn(this.#data, key) ? this.#data[key] : undefined;
  }

  set(key: string, value: unknown): this {
    setOwn(this.#data, key, value);
    return this;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#data, key);
  }

  delete(key: string): boolean {
    return this.has(key) && delete this.#data[key];
  }

  keys(): IterableIterator<string> {
    return Object.keys(this.#data)[Symbol.iterator]();
  }

  values(): IterableIterator<any> {
    return Object.values(this.#data)[Symbol.iterator]();
  }

  entries(): IterableIterator<[string, any]> {
    return Object.entries(this.#data)[Symbol.iterator]();
  }

  [Symbol.iterator](): IterableIterator<[string, any]> {
    return this.entries();
  }

  // -- dotted paths ------------------------------------------------------

  /**
   * Return the value at a dotted `path`, or `fallback` if absent.
   *
   * `cfg.getPath("SERVER_ID.config.disabled_users", [])` never throws on a
   * missing section, so it is the safe way to read optional settings. An empty
   * value (`key:`) is present and returns `null`, not the fallback.
   */
  getPath(path: string, fallback?: any, sep = "."): any {
    let node: unknown = this.#data;
    for (const part of path.split(sep)) {
      if (!isPlainObject(node) || !Object.hasOwn(node, part)) return fallback;
      node = node[part];
    }
    return node;
  }

  /**
   * Set the value at a dotted `path`, creating missing sections.
   *
   * @throws {TypeError} If an existing non-object value blocks the path.
   */
  setPath(path: string, value: unknown, sep = "."): this {
    const parts = path.split(sep);
    let node: Record<string, unknown> = this.#data;
    for (const [depth, part] of parts.slice(0, -1).entries()) {
      const child = Object.hasOwn(node, part) ? node[part] : undefined;
      if (child === undefined || child === null) {
        // Missing, or present but empty ('key:'); either way a section can be
        // grown here.
        const created = {};
        setOwn(node, part, created);
        node = created;
      } else if (isPlainObject(child)) {
        node = child;
      } else {
        const blocked = parts.slice(0, depth + 1).join(sep);
        throw new TypeError(
          `cannot descend into '${blocked}': it holds ${describe(child)}, not a section`,
        );
      }
    }
    setOwn(node, parts[parts.length - 1]!, value);
    return this;
  }

  /** Whether a dotted `path` exists (even if its value is `null`). */
  hasPath(path: string, sep = "."): boolean {
    const sentinel = Symbol();
    return this.getPath(path, sentinel, sep) !== sentinel;
  }

  /**
   * Return the object stored under `name`.
   *
   * @throws {RangeError} If the section is missing and `create` is false.
   * @throws {TypeError} If `name` holds something other than an object.
   */
  section(name: string, { create = false }: { create?: boolean } = {}): Data {
    if (!this.has(name)) {
      if (!create) throw new RangeError(`no such section: '${name}'`);
      this.set(name, {});
    }
    const value = this.#data[name];
    if (!isPlainObject(value)) {
      throw new TypeError(`section '${name}' holds ${describe(value)}, not an object`);
    }
    return value;
  }

  // -- whole-document operations ----------------------------------------

  /**
   * Merge `other` into this config in place and return `this`.
   *
   * With `deep: true` (the default) nested objects are merged recursively;
   * otherwise top-level keys are replaced outright.
   */
  merge(other: Record<string, unknown>, { deep = true }: { deep?: boolean } = {}): this {
    mergeInto(this.#data, other, deep);
    return this;
  }

  /**
   * Return the data as a plain object: a deep copy by default, so callers
   * cannot mutate the config by accident.
   */
  toObject({ deep = true }: { deep?: boolean } = {}): Data {
    return deep ? structuredClone(this.#data) : { ...this.#data };
  }

  /** Serialise this config to `.jp` text. */
  dumps(options: StringifyOptions = {}): string {
    return dumps(this.#data, { ...this.#writeOptions, ...options });
  }

  /**
   * Write the config to disk and return the path written.
   *
   * @param path Destination; defaults to the path the config is bound to, and
   *   becomes the bound path afterwards.
   * @throws {Error} If no path was given and none is bound.
   */
  async save(path?: PathLike | null, options: SaveOptions = {}): Promise<string> {
    const target = this.#target(path);
    await dump(this.#data, target, { ...this.#writeOptions, ...options });
    this.path = target;
    return target;
  }

  /** Synchronous {@link JPConfig.save}. */
  saveSync(path?: PathLike | null, options: SaveOptions = {}): string {
    const target = this.#target(path);
    dumpSync(this.#data, target, { ...this.#writeOptions, ...options });
    this.path = target;
    return target;
  }

  /** Re-read the bound file, discarding in-memory changes. */
  async reload(): Promise<this> {
    if (this.path === null) throw new Error("this config has no path to reload from");
    this.#data = await load(this.path, this.#readOptions);
    return this;
  }

  /** Synchronous {@link JPConfig.reload}. */
  reloadSync(): this {
    if (this.path === null) throw new Error("this config has no path to reload from");
    this.#data = loadSync(this.path, this.#readOptions);
    return this;
  }

  toString(): string {
    const where = this.path === null ? "" : ` path=${JSON.stringify(this.path)}`;
    return `<JPConfig${where} sections=${JSON.stringify(Object.keys(this.#data))}>`;
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }

  #target(path: PathLike | null | undefined): string {
    if (path != null) return toPath(path);
    if (this.path === null) {
      throw new Error("this config has no path; call save(path) or set .path first");
    }
    return this.path;
  }
}

function pick<K extends string>(source: object, keys: readonly K[]): { [P in K]?: any } {
  const out: { [P in K]?: any } = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) out[key] = (source as Record<K, unknown>)[key];
  }
  return out;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** Recursively merge `source` into `target`. */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>, deep: boolean) {
  for (const [key, value] of Object.entries(source)) {
    const current = Object.hasOwn(target, key) ? target[key] : undefined;
    if (deep && isPlainObject(current) && isPlainObject(value)) {
      mergeInto(current, value, true);
    } else {
      setOwn(target, key, value);
    }
  }
}
