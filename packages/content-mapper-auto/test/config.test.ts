import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseJsonc, readTsconfigEntry, resolveConfig, validateOptions } from "../src/core/config.ts";

test("parseJsonc handles comments and trailing commas but leaves strings alone", () => {
  const value = parseJsonc(`{
    // line comment
    "a": "x // not a comment, ]",   /* block */
    "b": [1, 2,],
    "c": { "d": "e,}", },
  }`);
  assert.deepEqual(value, { a: "x // not a comment, ]", b: [1, 2], c: { d: "e,}" } });
});

test("validateOptions keeps valid options and reports the rest with paths", () => {
  const { options, problems } = validateOptions({ model: "opus", tools: ["Read", 3], timeoutMs: -1, offline: true, nope: 1 });
  assert.deepEqual(options, { model: "opus", offline: true });
  assert.deepEqual(
    problems.map((p) => p.path),
    [["tools", 1], ["timeoutMs"], ["nope"]],
  );
  assert.equal(validateOptions("bad").problems.length, 1);
  assert.deepEqual(validateOptions(undefined), { options: {}, problems: [] });
});

test("resolveConfig applies defaults relative to the root", () => {
  const config = resolveConfig("/proj", { cacheDir: "gen" });
  assert.equal(config.cacheDir, path.resolve("/proj/gen"));
  assert.deepEqual(config.tools, ["Read", "Glob", "Grep"]);
});

test("readTsconfigEntry follows extends and references", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cma-config-"));
  writeFileSync(
    path.join(dir, "base.json"),
    `{ "contentMappers": [{ "package": "other", "extensions": [".x"] }, { "package": "content-mapper-auto", "extensions": [".auto"], "options": { "model": "m" } }] }`,
  );
  writeFileSync(path.join(dir, "tsconfig.app.json"), `{ "extends": "./base", "include": ["src"] }`);
  writeFileSync(path.join(dir, "tsconfig.json"), `{ "files": [], "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.app.json" }] }`);
  writeFileSync(path.join(dir, "tsconfig.node.json"), `{ "include": ["vite.config.ts"] }`);
  const entry = readTsconfigEntry(path.join(dir, "tsconfig.json"));
  assert.equal(entry?.configFileName, path.join(dir, "tsconfig.app.json"));
  assert.deepEqual(entry?.options, { model: "m" });
  assert.deepEqual(entry?.extensions, [".auto"]);
  assert.equal(readTsconfigEntry(path.join(dir, "missing.json")), undefined);
  assert.equal(readTsconfigEntry(path.join(dir, "tsconfig.node.json"))?.extensions, undefined);
});
