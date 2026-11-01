import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fakeClaude = path.join(packageDir, "test/fixtures/fake-claude.mjs");
export const tscBin = path.resolve(packageDir, "../../node_modules/.bin/tsc");
export const mapperMain = path.join(packageDir, "dist/mapper/main.js");

export interface ClaudeCall {
  source: string;
  description: string;
  cwd: string;
  argv: string[];
}

export interface Fixture {
  dir: string;
  write(file: string, text: string): void;
  read(file: string): string;
  calls(): ClaudeCall[];
  env: NodeJS.ProcessEnv;
}

/** Creates a throwaway project that uses content-mapper-auto, wired to the fake Claude CLI. */
export function createFixture(files: Record<string, string>, mapperOptions: object = {}): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "cma-test-"));
  mkdirSync(path.join(dir, "node_modules"));
  symlinkSync(packageDir, path.join(dir, "node_modules/content-mapper-auto"));
  const log = path.join(dir, "claude-calls.jsonl");
  const fixture: Fixture = {
    dir,
    write(file, text) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    },
    read: (file) => readFileSync(path.join(dir, file), "utf8"),
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ClaudeCall)
        : [],
    env: { ...process.env, CONTENT_MAPPER_AUTO_CLAUDE: fakeClaude, FAKE_CLAUDE_LOG: log, CONTENT_MAPPER_AUTO_OFFLINE: "" },
  };
  fixture.write("package.json", JSON.stringify({ name: "fixture", private: true, type: "module" }));
  fixture.write(
    "tsconfig.json",
    `{
      // JSONC is fine
      "compilerOptions": { "strict": true, "noEmit": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022", "types": [] },
      "contentMappers": [{ "package": "content-mapper-auto", "extensions": [".auto"], "options": ${JSON.stringify(mapperOptions)} }],
      "include": ["src"],
    }`,
  );
  for (const [file, text] of Object.entries(files)) fixture.write(file, text);
  return fixture;
}

export function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

export const tsc = (fixture: Fixture) =>
  run(tscBin, ["-p", ".", "--runExternalCode", "--pretty", "false"], { cwd: fixture.dir, env: fixture.env });

/** Runs a Vite library build of the fixture's src/main.ts in a child process (so env vars apply). */
export const viteBuild = (fixture: Fixture) => {
  const script = `
    import { build } from "vite";
    import auto from ${JSON.stringify(path.join(packageDir, "dist/vite/index.js"))};
    await build({
      root: ${JSON.stringify(fixture.dir)},
      configFile: false,
      logLevel: "warn",
      plugins: [auto()],
      build: { lib: { entry: "src/main.ts", formats: ["es"], fileName: "main" }, minify: false, outDir: "out" },
    });`;
  return run(process.execPath, ["--input-type=module", "-e", script], { cwd: packageDir, env: fixture.env });
};
