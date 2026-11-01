#!/usr/bin/env node
/**
 * The content-mapper-auto content mapper process. TypeScript (tsc with --runExternalCode, or the
 * language server) spawns it as declared by `typescript.contentMapper.exec` in package.json and
 * talks to it over stdio. For every `.auto` file in a program, `transform` returns the generated
 * TypeScript module from the shared cache, calling Claude when the cache is out of date.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeDescription } from "../core/cache.ts";
import { findPackageRoot, resolveConfig, validateOptions, type AutoOptions, type OptionProblem } from "../core/config.ts";
import { loadAutoModule } from "../core/index.ts";
import { ErrorCodes, RpcError, serve } from "./jsonrpc.ts";

const PROTOCOL_VERSION = 1;
const DIAGNOSTIC_SOURCE = "auto";

/** Diagnostic codes reported by this mapper (shown as `auto<code>`). */
const DiagnosticCode = {
  GenerationFailed: 1,
  UnsavedChanges: 2,
  Unavailable: 3,
  InvalidOption: 10,
} as const;

interface OpenProjectParams {
  configFileName?: string;
  projectHandle: string;
  options?: unknown;
  compilerOptions?: unknown;
}

interface TransformParams {
  fileName: string;
  content: string;
  projectHandle: string;
}

interface Project {
  configFileName: string | undefined;
  options: AutoOptions;
}

const projects = new Map<string, Project>();

function log(message: string): void {
  // stdout carries the protocol; the host collects stderr for its logs.
  process.stderr.write(`[content-mapper-auto] ${message}\n`);
}

function asObject(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object") throw new RpcError(ErrorCodes.InvalidParams, "Expected an object.");
  return params as Record<string, unknown>;
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") throw new RpcError(ErrorCodes.InvalidParams, `Expected '${key}' to be a string.`);
  return value;
}

function toOptionDiagnostics(problems: OptionProblem[]) {
  return problems.map((problem) => ({ path: problem.path, messageText: problem.message, code: DiagnosticCode.InvalidOption }));
}

/** Location of a mapper diagnostic: the first non-blank line of the description. */
function diagnosticSpan(content: string): { start: number; length: number } {
  const match = /\S[^\r\n]*/.exec(content);
  return match ? { start: match.index, length: match[0].length } : { start: 0, length: content.length };
}

async function readDisk(fileName: string): Promise<string | undefined> {
  try {
    return await readFile(fileName, "utf8");
  } catch {
    return undefined;
  }
}

async function transform(params: TransformParams) {
  const project = projects.get(params.projectHandle);
  const configFileName = project?.configFileName;
  const root = configFileName ? path.dirname(configFileName) : findPackageRoot(path.dirname(params.fileName));
  const config = resolveConfig(root, project?.options);

  // In an editor, transform runs on every keystroke. Only call Claude for content that has been
  // saved; while editing, keep serving the last generated module.
  const disk = await readDisk(params.fileName);
  const unsaved = disk !== undefined && normalizeDescription(disk) !== normalizeDescription(params.content);

  const result = await loadAutoModule({
    fileName: params.fileName,
    content: params.content,
    config,
    allowGenerate: !config.offline && !unsaved,
    onGenerate: (sourcePath) => log(`Generating ${sourcePath} with Claude...`),
  });

  if (result.status === "fresh") {
    return { text: result.code, extension: ".ts", mappings: [] };
  }
  const [code, messageText] = unsaved
    ? [DiagnosticCode.UnsavedChanges, "This description has unsaved changes. Save the file to regenerate the module."]
    : result.kind === "failed"
      ? [DiagnosticCode.GenerationFailed, result.reason]
      : [DiagnosticCode.Unavailable, result.reason];
  if (!unsaved) log(`${path.relative(root, params.fileName)}: ${result.reason}`);
  return {
    text: result.code ?? "export {};\n",
    extension: ".ts",
    mappings: [],
    diagnostics: [{ messageText, code, ...diagnosticSpan(params.content) }],
  };
}

async function handle(method: string, rawParams: unknown): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { protocolVersion: PROTOCOL_VERSION, positionEncoding: "utf-16", diagnosticSource: DIAGNOSTIC_SOURCE };
    case "openProject": {
      const params = asObject(rawParams) as unknown as OpenProjectParams;
      const handle = requireString(params as unknown as Record<string, unknown>, "projectHandle");
      const { options, problems } = validateOptions(params.options);
      projects.set(handle, { configFileName: params.configFileName || undefined, options });
      return problems.length > 0 ? { optionDiagnostics: toOptionDiagnostics(problems) } : {};
    }
    case "closeProject": {
      projects.delete(requireString(asObject(rawParams), "projectHandle"));
      return null;
    }
    case "transform": {
      const params = asObject(rawParams);
      return transform({
        fileName: requireString(params, "fileName"),
        content: requireString(params, "content"),
        projectHandle: requireString(params, "projectHandle"),
      });
    }
    default:
      throw new RpcError(ErrorCodes.MethodNotFound, `Unknown method '${method}'.`);
  }
}

await serve(process.stdin, process.stdout, handle);
process.exit(0);
