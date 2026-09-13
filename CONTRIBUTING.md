# Contributing

## Getting set up

```bash
bun install
bun test
```

Development uses [Bun](https://bun.com) for installing and testing; the
published package targets Node 20+ and has no runtime dependencies.
`bun run typecheck` type-checks the sources and tests, `bun run build` compiles
`src/` to `dist/`, and `bun src/bin.ts ...` runs the CLI from the working tree.

## Project layout

```
src/
├─ index.ts      public exports (Node, Bun, Deno)
├─ core.ts       loads/dumps and types, no filesystem -- the "jpml/core" export
├─ errors.ts     JPError, JPDecodeError (with line/column), JPEncodeError
├─ scanner.ts    cursor, whitespace, comments, strings, bare tokens
├─ parser.ts     recursive-descent grammar
├─ writer.ts     deterministic serialiser
├─ values.ts     value types and shared helpers
├─ files.ts      load/dump/loadDir and their Sync twins
├─ config.ts     JPConfig
├─ cli.ts        the jpml command
├─ bin.ts        executable entry point
└─ version.ts    version, read from package.json
test/
└─ jpml.test.ts
```

The package mirrors [jpml-py](https://github.com/jpml-lang/jpml-py) module for
module. Keep the two in step: a change to the grammar, the error messages or the
writer's output belongs in both, so files move between them unchanged.

The split is deliberate: `scanner.ts` owns every *lexical* concern and knows
nothing about the grammar, while `parser.ts` owns the grammar and drives the
scanner directly. There is no standalone token stream, because the format is
context sensitive — `[` opens a section header at the top level but an array
everywhere a value is expected.

Nothing reachable from `core.ts` may import a `node:` module, so that
`jpml/core` keeps working in browsers.

## Tests

```bash
bun test
```

CI (`.github/workflows/ci.yml`) type-checks and runs the suite on Linux, Windows
and macOS for every push and pull request, validates the bundled `.jp` files,
and smoke-tests the compiled package under each supported Node version.

`jpml fmt` is deliberately *not* enforced in CI: rewriting a file drops its
comments, so formatting stays a manual choice.

## Releasing

Publishing runs from `.github/workflows/publish.yml` using npm **Trusted
Publishing** (OIDC), so there are no npm tokens or repository secrets to manage,
and every release gets a provenance attestation.

### One-time setup

1. Create a GitHub environment named `npm` under
   **Settings → Environments**. Adding a required reviewer to it gives a manual
   approval gate before anything is published.
2. npm only lets you configure a trusted publisher for a package that already
   exists, so publish the first version by hand from a clean checkout:
   ```bash
   npm login
   npm publish --access public
   ```
3. On <https://www.npmjs.com/package/jpml/access>, add a trusted publisher:

   | Field | Value |
   | --- | --- |
   | Publisher | GitHub Actions |
   | Organization or user | `jpml-lang` |
   | Repository | `jpml-npm` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm` |

   While you are there, consider setting publishing access to *require
   two-factor authentication and disallow tokens*, so the workflow is the only
   way in.

### Cutting a release

```bash
# 1. bump "version" in package.json -- the only place it lives;
#    the exported `version` and `jpml --version` read it at runtime.
git commit -am "Release 1.1.2"
git tag v1.1.2
git push --follow-tags
```

Then publish a GitHub Release for that tag. The workflow installs the project,
type-checks, runs the tests, checks that the tag matches the version in
`package.json`, builds and packs the tarball, and publishes it to npm with
provenance.

The tag must match the version exactly — `"version": "1.1.1"` needs the tag
`v1.1.1`, or the build fails before anything is published.

If publishing fails after the tarball was built, re-run the workflow from
**Actions → Publish → Run workflow**. npm refuses to overwrite a version that
already exists, so a partially published release needs a version bump rather
than a retry.
