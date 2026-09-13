# jpml-lang

JavaScript/TypeScript package for JPML

[![CI](https://github.com/jpml-lang/jpml-npm/actions/workflows/ci.yml/badge.svg)](https://github.com/jpml-lang/jpml-npm/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/jpml-lang)](https://www.npmjs.com/package/jpml-lang)

**A configuration language that borrows TOML's sections and JSON's nesting.**

`.jp` files use `[SECTION]` headers at the top level and `{...}` / `[...]`
structures inside them. Keys need no quotes, `#` starts a comment, trailing
commas are fine, and a value is allowed to be *empty*.

```jp
[SERVER_ID]
config: {
  disabled_channels:,
  disabled_users: [9892, 82082, 8209]
}

[SERVER_ID_2]
prefix: "!"
modules: {
  moderation: true,
  fun: false
}
```

```ts
import { load } from "jpml-lang";

await load("data/servers.jp");
// {
//   SERVER_ID: { config: { disabled_channels: null, disabled_users: [9892, 82082, 8209] } },
//   SERVER_ID_2: { prefix: "!", modules: { moderation: true, fun: false } }
// }
```

This is the JavaScript twin of [`jpml` on PyPI](https://github.com/jpml-lang/jpml-py):
the same format, the same error messages and the same writer, so a file written
by one reads back unchanged in the other. (See [Round trips](#round-trips) for
the two places JavaScript itself makes the output differ.)

---

## Why another format

JSON has no comments, demands quotes on every key, and rejects a trailing
comma. TOML has comments and headers, but nesting anything non-trivial means
either deeply dotted keys or a table per level.

`.jp` takes the half of each that suits configuration files people edit by hand:

* **Sections for the top level.** `[SERVER_ID]` reads better than another brace.
* **JSON for everything below it.** Nest objects and arrays as deep as you like.
* **No ceremony.** Unquoted keys, comments anywhere, trailing commas ignored.
* **Empty values are legal.** `disabled_channels:,` means the key exists and has
  no value yet — a real state in configs that JSON can only spell as `null`.

It is a small, fully specified format with a strict parser, precise error
messages, and a deterministic writer, so files stay stable when a program
rewrites them.

```bash
npm install jpml-lang     # or: bun add jpml-lang / pnpm add jpml-lang / yarn add jpml-lang
```

No runtime dependencies. Ships ESM with TypeScript types. Node 20+, Bun and Deno.

The package is published as `jpml-lang` (npm reserves names that look like
existing packages), but the command it installs is still `jpml`.

---

## The format

### Sections

A `[NAME]` header opens a root key. Everything below it, until the next header,
belongs to that section.

```jp
[SERVER_ID]
prefix: "!"
```

Headers may be dotted to nest, and quoted when a name contains a dot:

```jp
[guild.limits]        # -> { guild: { limits: {...} } }
["weird.name"]        # -> { "weird.name": {...} }
```

Key/value pairs written *before* the first header land at the document root:

```jp
version: 2

[SERVER_ID]
prefix: "!"
```

### Entries

An entry is `key: value`. Keys need no quotes; a bare key may contain spaces but
not brackets, commas or quotes — quote it if it needs those.

Entries are separated by a line break, a comma, or both. Trailing and repeated
commas are accepted:

```jp
[SERVER_ID]
a: 1
b: {x: 1, y: 2,}
c: [1, 2, 3,]
```

### Empty values

A key with nothing after the colon parses to `null`:

```jp
config: {
  disabled_channels:,      # -> null
  timeout:                 # -> null
}
```

Because of this, **a value must start on the same line as its `:`**. An opening
`{` or `[` goes on the colon's line; its contents may then wrap freely.

### Values

| Type | Examples | Parses to |
| --- | --- | --- |
| String | `"hello"`, `'hello'`, `hello world` (unquoted) | `string` |
| Integer | `42`, `-7`, `1_000`, `0xff`, `0o755`, `0b1010` | `number`, or `bigint` beyond 2^53 |
| Float | `3.5`, `1e3`, `inf`, `-inf`, `nan` | `number` |
| Boolean | `true`, `false` (case-insensitive, so `True` works too) | `boolean` |
| Null | `null`, `none`, `nil`, or nothing at all | `null` |
| Object | `{a: 1, b: 2}` | plain object |
| Array | `[1, 2, 3]` | array |

Unquoted values are read as a keyword first, then a number, then a plain string.
Quote a value if it contains a `#`, a comma, a bracket, or leading/trailing
whitespace you want to keep.

Strings honour the usual escapes — `\n`, `\t`, `\\`, `\"`, `\uXXXX`,
`\U0001F600`, plus `\` at end of line to continue onto the next.

### Comments

`#` runs to the end of the line and is allowed anywhere, including inside
objects and arrays.

---

## What you can do with it

### Read and write files

```ts
import * as jpml from "jpml-lang";

const data = await jpml.load("data/servers.jp");   // -> object
await jpml.dump(data, "data/servers.jp");          // formatted, atomic write

const text = jpml.dumps(data);                     // -> string
const again = jpml.loads(text);                    // -> object
```

Every file function has a synchronous twin — `loadSync`, `dumpSync`,
`loadDirSync` — for startup code that would rather not `await`. Paths may be
strings or `file:` URLs. `parse` and `stringify` are aliases of `loads` and
`dumps` if you prefer the `JSON` spelling.

Writes are atomic by default: the file goes to a temporary neighbour and is
renamed into place, so a crash or a concurrent reader never sees half a config.

Options worth knowing:

```ts
jpml.loads(text, { duplicateKeys: "last" });      // "error" (default), "first", "last"
jpml.loads(text, { integers: "bigint" });         // "auto" (default), "bigint", "number"
jpml.dumps(data, { indent: 4, sortKeys: true });  // also: width, ensureAscii
jpml.dumps(data, { default: (v) => (v instanceof Date ? v.toISOString() : String(v)) });
```

### Big numbers stay exact

JavaScript numbers lose precision past 2^53, which is exactly where Discord
snowflakes and other 64-bit IDs live. By default an integer that fits safely
parses to a `number` and one that doesn't parses to a `bigint`, so no digit is
ever silently changed:

```ts
jpml.loads("[s]\nsmall: 42\nid: 111111111111111111\n");
// { s: { small: 42, id: 111111111111111111n } }
```

`bigint` values are written back as plain integers. Pass `integers: "bigint"` to
get a `bigint` for every integer, or `integers: "number"` to always get a
`number` and accept the precision loss.

### Edit a config in place

`JPConfig` is a map-like object that remembers the file it came from.

```ts
import { JPConfig } from "jpml-lang";

const cfg = await JPConfig.load("data/servers.jp", { missingOk: true });

cfg.data.SERVER_ID.prefix;                               // plain object access
cfg.get("SERVER_ID");                                    // also: set, has, delete, keys, size
cfg.getPath("SERVER_ID.config.disabled_users", []);      // never throws
cfg.setPath("SERVER_ID.config.disabled_users", [9892]);  // creates missing sections
cfg.hasPath("SERVER_ID.prefix");
cfg.section("NEW_SERVER", { create: true }).prefix = "?";
cfg.merge({ SERVER_ID: { modules: { fun: true } } });    // deep merge
await cfg.save();                                        // atomic, back to its own path
await cfg.reload();                                      // discard in-memory changes
cfg.toObject();                                          // deep copy as a plain object
```

`loadSync`, `saveSync` and `reloadSync` do the same without promises.

`missingOk: true` gives an empty config bound to the path, which is what you
want for a program that writes its config on first run. Formatting options given
when loading or constructing are remembered by `save()`:

```ts
const cfg = await JPConfig.load("data/servers.jp", { indent: 4, sortKeys: true });
```

### Load a whole folder

```ts
const config = await jpml.loadDir("data");            // { servers: {...}, roles: {...} }
const guilds = await jpml.loadDir("data/guilds");     // { "1234567890": {...}, ... }
const everything = await jpml.loadDir("data", { recursive: true });
```

Each file becomes one key, named after the file. Nested files are keyed by
their relative path (`"guilds/1234567890"`), and `pattern` picks which files
count (default `"*.jp"`).

### Find mistakes quickly

Every error derives from `JPError`. `JPDecodeError` points at the exact
character:

```
data/servers.jp:2:8: expected ':' after key 'prefix', found '"'
    prefix "!"
           ^
```

It carries `.line`, `.col`, `.pos`, `.filename` and `.rawMessage` if you want to
render the failure yourself. `JPEncodeError` explains what could not be
serialised — an unsupported type, a non-string key, a circular reference.

By default a repeated key is an error rather than a silent overwrite; pass
`duplicateKeys: "first"` or `"last"` if you would rather it not be.

### Work from the shell

```bash
npx jpml-lang check data/*.jp                      # validate; non-zero exit on failure
npx jpml-lang fmt -w data/servers.jp               # reformat in place
npx jpml-lang get data/servers.jp SERVER_ID.prefix # read one value
npx jpml-lang to-json data/servers.jp -o out.json
npx jpml-lang from-json out.json -o data/servers.jp
```

`-` reads stdin. Large integers survive `to-json` and `from-json` intact.

### In the browser

`jpml-lang/core` is the same parser and writer without any filesystem access, for
browsers, workers and edge runtimes:

```ts
import { loads, dumps, JPDecodeError } from "jpml-lang/core";
```

---

## Round trips

`dumps` is deterministic, so a file rewritten twice is byte-identical:

* every top-level object becomes a `[SECTION]`, separated by a blank line;
* section entries sit one per line, with no separating commas;
* nested objects always expand across lines, `{}` being the only inline form;
* arrays stay inline while they fit inside `width` (default 88), then break one
  element per line;
* `null` is written as an empty value inside objects (`key:`) and as `null`
  inside arrays, since an array element cannot be empty;
* insertion order is preserved unless `sortKeys: true`.

As with `JSON.stringify`, object properties whose value is `undefined` are
skipped and `undefined` array elements are written as `null`. A `Map` is
written like an object, and may use integer keys.

Some things do not survive a rewrite:

* **Comments are dropped.** Rewriting a hand-annotated file loses its notes.
* **Root-level scalars move above the first section**, because anything after a
  header would be read back as part of that section.
* **Integer-like keys move to the front.** JavaScript objects always list keys
  such as `"1234567890"` first, in ascending order, before every other key. A
  `[1234567890]` section therefore comes out ahead of `[SERVER_ID]` even if the
  file had it last. Pass a `Map` to `dumps` if the order of such keys matters.
* **Whole floats become integers.** JavaScript has one number type, so `1.0`
  reads back as `1` and is written as `1`.

---

## Organising your configs

Nothing is enforced, but this layout is what `loadDir` is built for:

```
your-project/
├─ data/
│  ├─ servers.jp            # one file per concern
│  ├─ roles.jp
│  ├─ servers.example.jp    # committed template, safe to publish
│  └─ guilds/               # optional: one file per entity
│     ├─ 1234567890.jp
│     └─ 9876543210.jp
└─ src/
```

A few habits that save pain later:

1. **One file per concern.** A parse error then takes out one feature, not
   everything.
2. **Keep live data out of git**, and commit a template instead:
   ```gitignore
   data/*.jp
   !data/*.example.jp
   ```
3. **Use IDs as section names.** `[1234567890]` parses to the string key
   `"1234567890"`, which is how JavaScript stores object keys anyway.
4. **Write through `JPConfig.save()`** rather than by hand, so an interrupted
   write cannot truncate a live config.
5. **Validate in CI** with `npx jpml-lang check data/*.jp`.

---

## Licence

MIT. Contributing, tests and release process: [CONTRIBUTING.md](CONTRIBUTING.md).
