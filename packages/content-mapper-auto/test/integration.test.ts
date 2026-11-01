import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createFixture, tsc, viteBuild } from "./helpers.ts";

const MAIN = `import { greet } from "./greet.auto";\nexport const message: string = greet("tsc");\n`;
const GREET = "Export greet.\ncode: export function greet(name: string): string { return `hello ${name}`; }\n";

test("tsc type-checks against the generated module and reports type errors in importers", async () => {
  const fixture = createFixture({
    "src/greet.auto": GREET,
    "src/main.ts": MAIN,
    "src/wrong.ts": `import { greet } from "./greet.auto";\nexport const n: number = greet("x");\n`,
  });
  const result = await tsc(fixture);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /src\/wrong\.ts\(2,14\): error TS2322: Type 'string' is not assignable to type 'number'/);
  assert.equal(fixture.calls().length, 1);
  assert.equal(fixture.calls()[0]!.source, "src/greet.auto");
});

test("Vite reuses the module generated for tsc, and vice versa", async () => {
  const first = createFixture({ "src/greet.auto": GREET, "src/main.ts": MAIN });
  assert.equal((await tsc(first)).code, 0);
  const built = await viteBuild(first);
  assert.equal(built.code, 0, built.output);
  assert.match(first.read("out/main.js"), /hello \$\{name\}/);
  assert.equal(first.calls().length, 1, "vite build did not call Claude again");

  const second = createFixture({ "src/greet.auto": GREET, "src/main.ts": MAIN });
  assert.equal((await viteBuild(second)).code, 0);
  const checked = await tsc(second);
  assert.equal(checked.code, 0, checked.output);
  assert.equal(second.calls().length, 1, "tsc did not call Claude again");
});

test("concurrent tsc and Vite runs share a single generation", async () => {
  const fixture = createFixture({
    "src/greet.auto": "SLOW greet.\ncode: export function greet(name: string): string { return name; }\n",
    "src/main.ts": MAIN,
  });
  const [checked, built] = await Promise.all([tsc(fixture), viteBuild(fixture)]);
  assert.equal(checked.code, 0, checked.output);
  assert.equal(built.code, 0, built.output);
  assert.equal(fixture.calls().length, 1);
  assert.ok(!existsSync(path.join(fixture.dir, ".auto-cache/src/greet.auto.ts.lock")), "lock released");
});

test("offline mode never calls Claude and fails on a stale cache", async () => {
  const fixture = createFixture({ "src/greet.auto": GREET, "src/main.ts": MAIN }, { offline: true });
  const checked = await tsc(fixture);
  assert.equal(checked.code, 2);
  assert.match(checked.output, /src\/greet\.auto\(1,1\): error auto3: No up-to-date generated module for src\/greet\.auto/);
  const built = await viteBuild(fixture);
  assert.notEqual(built.code, 0);
  assert.match(built.output, /No up-to-date generated module/);
  assert.equal(fixture.calls().length, 0);
});

test("Vite reports generation failures as build errors", async () => {
  const fixture = createFixture({ "src/greet.auto": "FAIL\n", "src/main.ts": MAIN });
  const built = await viteBuild(fixture);
  assert.notEqual(built.code, 0);
  assert.match(built.output, /src\/greet\.auto: Claude could not implement the description/);
});
