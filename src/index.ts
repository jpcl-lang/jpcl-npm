/**
 * jpml -- a hybrid JSON/TOML configuration language.
 *
 * `.jp` files use TOML-style `[SECTION]` headers at the top level and
 * JSON-style `{...}` / `[...]` structures inside them, with unquoted keys and
 * `#` comments:
 *
 * ```
 * [SERVER_ID]
 * config: {
 *   disabled_channels:,
 *   disabled_users: [9892, 82082, 8209]
 * }
 * ```
 *
 * Typical use:
 *
 * ```ts
 * import * as jpml from "jpml";
 *
 * const data = await jpml.load("data/servers.jp");       // -> object
 * await jpml.dump(data, "data/servers.jp");              // formatted, atomic write
 *
 * const cfg = await jpml.JPConfig.load("data/servers.jp");
 * cfg.setPath("SERVER_ID.prefix", "!");
 * await cfg.save();
 * ```
 *
 * @module
 */

export * from "./core.js";
export {
  dump,
  dumpSync,
  load,
  loadDir,
  loadDirSync,
  loadSync,
  type DumpOptions,
  type LoadDirOptions,
  type LoadOptions,
  type PathLike,
} from "./files.js";
export {
  JPConfig,
  type ConfigOptions,
  type JPConfigInit,
  type JPConfigLoadOptions,
  type SaveOptions,
} from "./config.js";
export { version } from "./version.js";
