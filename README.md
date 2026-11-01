# content-mapper-auto

Describe a TypeScript module in plain English in a `.auto` file, import it, and let Claude
implement it.

The package combines a [TypeScript 7.1 content mapper](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/)
and a Vite plugin. The content mapper gives `tsc` and your editor the real types of the generated
module. The Vite plugin runs the same code. Both read and write one shared cache of generated
modules, so they always agree.

```text
src/relative-time.auto                       src/main.ts
─────────────────────────────────────        ───────────────────────────────────────────────
Export a function                            import { formatRelativeTime } from "./relative-time.auto";
`formatRelativeTime(date: Date,
now?: Date): string` that describes          formatRelativeTime(new Date(Date.now() - 90 * 60_000));
how long ago `date` was ...                  // → "2 hours ago"
```

The full documentation is in [packages/content-mapper-auto](packages/content-mapper-auto/README.md).

## Repository layout

| Path                                                       | Contents                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------- |
| [`packages/content-mapper-auto`](packages/content-mapper-auto) | The package: shared core, content mapper process, Vite plugin |
| [`examples/demo`](examples/demo)                           | A todo app whose store and time formatting are `.auto` files   |

Inside the package:

- `src/core/`: configuration, the shared cache (keys, cross-process locking, atomic writes), and the
  Claude CLI generator.
- `src/mapper/`: the content mapper process. It speaks JSON-RPC over stdio (`initialize`,
  `openProject`, `transform`, `closeProject`), as declared under `typescript.contentMapper.exec` in
  its `package.json`.
- `src/vite/`: the Vite plugin.

## Development

```sh
npm install
npm test               # builds, then runs unit, protocol and tsc+Vite integration tests (with a fake Claude CLI)
npm run demo:typecheck # tsc --runExternalCode on the demo
npm run demo:dev       # vite dev server for the demo
npm run demo:build     # type-check, then vite build
```

The demo's generated modules are committed in `examples/demo/.auto-cache`, so the demo type-checks
and runs without calling Claude. Edit a `.auto` file to see it regenerate.
