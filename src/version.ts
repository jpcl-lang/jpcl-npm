import { createRequire } from "node:module";

/**
 * The installed package version, read from `package.json` so that it is the
 * only place a release version has to be bumped.
 */
export const version: string = createRequire(import.meta.url)("../package.json").version;
