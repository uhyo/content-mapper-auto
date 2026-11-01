import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { after, before, test } from "node:test";
import { createFixture, mapperMain, packageDir } from "./helpers.ts";

/** Minimal client for the content mapper protocol (JSON-RPC 2.0 with Content-Length framing). */
class MapperClient {
  private nextId = 1;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  readonly child: ChildProcessWithoutNullStreams;
  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, end).toString())![1]);
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
        this.buffer = this.buffer.subarray(end + 4 + length);
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(Object.assign(new Error(message.error.message), message.error));
        else waiter?.resolve(message.result);
      }
    });
  }
  call(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

const fixture = createFixture({
  "src/math.auto": "Export add.\ncode: export function add(a: number, b: number): number { return a + b; }\n",
  "src/bad.auto": "Please FAIL.\n",
});
const configFileName = path.join(fixture.dir, "tsconfig.json");
let client: MapperClient;

before(() => {
  client = new MapperClient(spawn(process.execPath, [mapperMain], { cwd: packageDir, env: fixture.env }));
});
after(() => client.child.stdin.end());

test("initialize negotiates protocol version 1 with UTF-16 positions", async () => {
  const result = await client.call("initialize", { protocolVersion: 1, positionEncodings: ["utf-8", "utf-16"] });
  assert.deepEqual(result, { protocolVersion: 1, positionEncoding: "utf-16", diagnosticSource: "auto" });
});

test("openProject validates options", async () => {
  assert.deepEqual(await client.call("openProject", { configFileName, projectHandle: "p1", compilerOptions: {} }), {});
  const result = await client.call("openProject", { configFileName, projectHandle: "p2", options: { cacheDir: 1 }, compilerOptions: {} });
  assert.deepEqual(result.optionDiagnostics, [{ path: ["cacheDir"], messageText: "Option 'cacheDir' must be a non-empty string.", code: 10 }]);
});

test("transform generates, caches and returns a fully synthesized TypeScript module", async () => {
  const fileName = path.join(fixture.dir, "src/math.auto");
  const content = fixture.read("src/math.auto");
  const result = await client.call("transform", { fileName, content, projectHandle: "p1" });
  assert.equal(result.extension, ".ts");
  assert.deepEqual(result.mappings, []);
  assert.equal(result.diagnostics, undefined);
  assert.match(result.text, /export function add\(a: number, b: number\): number/);
  assert.equal(fixture.read(".auto-cache/src/math.auto.ts"), result.text);
  assert.equal(fixture.calls().length, 1);
  assert.equal(fixture.calls()[0]!.cwd, fixture.dir, "Claude runs in the project root");

  const again = await client.call("transform", { fileName, content: content.replace(/\n/g, "\r\n"), projectHandle: "p1" });
  assert.equal(again.text, result.text);
  assert.equal(fixture.calls().length, 1, "served from cache");
});

test("unsaved editor content keeps the last module and asks to save", async () => {
  const fileName = path.join(fixture.dir, "src/math.auto");
  const edited = "Export add, but typing in progress...\n";
  const result = await client.call("transform", { fileName, content: edited, projectHandle: "p1" });
  assert.match(result.text, /export function add/);
  assert.equal(result.diagnostics[0].code, 2);
  assert.deepEqual([result.diagnostics[0].start, result.diagnostics[0].length], [0, edited.trimEnd().length]);
  assert.equal(fixture.calls().length, 1, "Claude is not called for unsaved content");
});

test("generation failures become diagnostics on the .auto file", async () => {
  const fileName = path.join(fixture.dir, "src/bad.auto");
  const result = await client.call("transform", { fileName, content: fixture.read("src/bad.auto"), projectHandle: "p1" });
  assert.equal(result.text, "export {};\n");
  assert.equal(result.diagnostics[0].code, 1);
  assert.match(result.diagnostics[0].messageText, /something impossible/);
});

test("unknown methods are rejected", async () => {
  await assert.rejects(client.call("bogus", {}), { code: -32601 });
  assert.equal(await client.call("closeProject", { projectHandle: "p2" }), null);
});
