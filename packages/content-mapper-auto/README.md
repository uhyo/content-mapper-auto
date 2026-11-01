# content-mapper-auto

Write a plain-language description of a module in a `.auto` file, import it from TypeScript, and let
Claude write the code.

```text
// src/slugify.auto
Export a function `slugify(input: string): string` that lowercases the input,
removes diacritics, replaces runs of non-alphanumeric characters with a single
"-" and trims leading and trailing dashes.
```

```ts
// src/main.ts
import { slugify } from "./slugify.auto";

slugify("Héllo, World!"); // "hello-world"
slugify(42); // error TS2345: Argument of type 'number' is not assignable to parameter of type 'string'.
```

The package has two parts that share one cache:

- **A TypeScript 7.1 content mapper.** `tsc` and the TypeScript language server treat every `.auto`
  file as the TypeScript module Claude generated from it, so importers get real types, errors, and
  completions.
- **A Vite plugin.** Vite serves and bundles the same generated module, so the code that runs is
  exactly the code that was type-checked.

## Requirements

- TypeScript 7.1 (`typescript@7.1.0-beta` or later). Content mappers are new in 7.1.
- [Claude Code](https://claude.com/claude-code) installed and signed in, so that `claude` is on your
  `PATH` (or see the `claudeCommand` option). You don't need it if the cache is already up to date.
- Node.js 22.18 or later. Vite 7 or 8 if you use the plugin.

## Setup

```sh
npm install -D content-mapper-auto typescript@beta vite
```

Register the mapper in `tsconfig.json`:

```jsonc
{
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true
  },
  "contentMappers": [
    {
      "package": "content-mapper-auto",
      "extensions": [".auto"],
      "options": {
        // all optional, see below
        "instructions": "Target modern browsers."
      }
    }
  ]
}
```

Content mappers run external code, so `tsc` only runs them when you pass `--runExternalCode`:

```sh
npx tsc --runExternalCode
```

Add the plugin to `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import auto from "content-mapper-auto/vite";

export default defineConfig({
  plugins: [auto()],
});
```

The plugin reads its options from the `contentMappers` entry in `tsconfig.json`, so you configure the
mapper in one place. It follows `extends` and project `references`, such as the `tsconfig.app.json`
in Vite's templates.

In VS Code with the TypeScript 7 language server, content mappers need a trusted workspace and the
content mapper permission. The `js/ts.contentMappers.enabled` setting turns them off.

## How it works

```text
            src/foo.auto (description)
                     │
         ┌───────────┴────────────┐
   tsc / tsserver               Vite
  (content mapper)             (plugin)
         └───────────┬────────────┘
                loadAutoModule()
                     │  key = sha256(description, path, model, instructions)
      .auto-cache/src/foo.auto.ts ── fresh? ──▶ use it
                     │ stale or missing
            claude --print (read-only tools)
                     │
          write the cache atomically, under a lock
```

- **One code path.** Both tools call the same `loadAutoModule()` function and resolve options and the
  project root the same way: the directory of the tsconfig that registers the mapper.
- **Cache.** The cache mirrors your source tree: `src/foo.auto` is stored as
  `.auto-cache/src/foo.auto.ts`, with a header holding the cache key. An entry is up to date when its
  key matches the description (line endings and trailing whitespace are ignored), the file's path, the
  `model`, and the `instructions`. **Commit `.auto-cache`.** Then everyone on the team, and CI, runs
  the same code without calling Claude. Changes to generated code also show up as reviewable diffs.
- **No duplicate generations.** While a module is being generated, a lock file next to the cache
  entry makes other processes wait for the result instead of calling Claude again. This covers your
  editor, `tsc --watch`, and `vite dev` running at the same time.
- **Claude's context.** Claude runs in the project root with only the read-only `Read`, `Glob`, and
  `Grep` tools. A description like "takes a `Todo` from ./types" therefore produces an import of the
  real type. The output must be a strict, `isolatedModules`-compatible ES module with explicit types
  on its exports.
- **Editors.** The language server calls the mapper on every keystroke in a `.auto` file. The mapper
  calls Claude only for content that matches the file on disk. While you edit, it keeps serving the
  last generated module and shows an "unsaved changes" diagnostic. Save the file to regenerate.
- **Failures.** If Claude fails or rejects the description, `tsc` reports a diagnostic on the `.auto`
  file and Vite reports a build error. If an older cached module exists, the mapper keeps serving it
  so the rest of the project still has types.

The generated module is mapped as fully synthesized TypeScript. Type errors in importers are
reported at their usual locations. An error inside the generated code is reported on the `.auto`
file with a note that it is in virtual code. Its line and column refer to the cache file, which is
exactly the virtual text:

```text
src/math.auto(5,14): error TS2322: Type 'string' is not assignable to type 'number'.
  This location is in virtual code produced by the content mapper 'content-mapper-auto@0.1.0' and has no corresponding location in the original file.
```

### Diagnostics

| Code    | Meaning                                                                      |
| ------- | ---------------------------------------------------------------------------- |
| `auto1` | Generation failed (Claude error, timeout, or a description it rejected).      |
| `auto2` | The editor buffer has unsaved changes; save to regenerate.                   |
| `auto3` | No up-to-date module and generation is not possible (offline, empty file).   |
| `auto10` | Invalid mapper option in `tsconfig.json`.                                   |

## Options

Set options in the tsconfig entry's `options`, or pass them to `auto({...})`. Plugin options override
the tsconfig ones.

| Option          | Default                       | Description                                                                                          |
| --------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `cacheDir`      | `".auto-cache"`               | Cache directory, relative to the project root.                                                       |
| `model`         | the CLI's default             | Passed to `claude --model`. Part of the cache key.                                                   |
| `instructions`  | `""`                          | Extra instructions added to every prompt, e.g. coding conventions. Part of the cache key.            |
| `claudeCommand` | `["claude"]`                  | Command used to run the Claude CLI. The `CONTENT_MAPPER_AUTO_CLAUDE` env var (a path or JSON array) is used when unset. |
| `tools`         | `["Read", "Glob", "Grep"]`    | Claude Code tools the generator may use. `[]` disables all of them.                                  |
| `timeoutMs`     | `600000`                      | Time limit for one generation.                                                                       |
| `concurrency`   | `4`                           | Maximum number of concurrent Claude processes per tool process.                                      |
| `offline`       | `false`                       | Never call Claude; fail when the cache is missing or stale. `CONTENT_MAPPER_AUTO_OFFLINE=1` also enables it. |

Options that only the Vite plugin accepts:

| Option       | Default                          | Description                                                   |
| ------------ | -------------------------------- | ------------------------------------------------------------- |
| `tsconfig`   | `"tsconfig.json"`                | The tsconfig to read options from, relative to the Vite root. `false` ignores tsconfig files. |
| `extensions` | from the tsconfig, or `[".auto"]` | File extensions to handle.                                    |

Because `model` and `instructions` are part of the cache key, the mapper and the plugin must use the
same values. Configure them in the tsconfig entry rather than only in the plugin.

### On CI

Commit `.auto-cache` and run with `CONTENT_MAPPER_AUTO_OFFLINE=1`. `tsc --runExternalCode` and
`vite build` then fail with `auto3` if someone changed a description without committing the
regenerated module.

## Caveats

- Claude is not deterministic. The same description can produce different code after a cache miss.
  This is why the cache is designed to be committed. To force a regeneration, delete the entry from
  `.auto-cache`. Hand edits to a cached module are kept until its description changes.
- The cache key covers the description, but not the files Claude read while generating. If you
  change `./types.ts` in a way that matters, regenerate the affected modules by deleting their cache
  entries.
- `tsc --build` / `incremental` record the mapper's identity (package version and options), not the
  cache contents. After deleting or hand-editing cache entries, run a non-incremental check, or remove
  `.tsbuildinfo`.
- `tsc` reports mapper diagnostics as syntax errors, so they can hide semantic errors elsewhere until
  you fix them.

## API

The core is also available as a library:

```ts
import { loadAutoModule, resolveConfig } from "content-mapper-auto";

const result = await loadAutoModule({
  fileName: "/abs/path/src/foo.auto",
  content: description,
  config: resolveConfig("/abs/path", { model: "opus" }),
});
if (result.status === "fresh") console.log(result.code);
```
