import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Options accepted both by the content mapper (as the `options` object of its tsconfig
 * `contentMappers` entry) and by the Vite plugin. The Vite plugin reads the tsconfig entry by
 * default, so the two tools normally share one configuration and one cache.
 */
export interface AutoOptions {
  /**
   * Where generated modules are stored, relative to the project root (the directory of the
   * tsconfig that registers the mapper). Defaults to `.auto-cache`. Committing this directory makes
   * builds reproducible without calling Claude.
   */
  cacheDir?: string;
  /** Model passed to `claude --model`. Defaults to the Claude CLI's default model. */
  model?: string;
  /** Extra project-wide instructions appended to every generation prompt (coding style etc.). */
  instructions?: string;
  /**
   * Command used to run the Claude CLI, as an argv prefix. Defaults to the
   * `CONTENT_MAPPER_AUTO_CLAUDE` environment variable (a path or a JSON array), or `["claude"]`.
   */
  claudeCommand?: string[];
  /**
   * Claude Code tools the generator may use. Defaults to read-only tools so that Claude can look at
   * the project's other modules and types: `["Read", "Glob", "Grep"]`.
   */
  tools?: string[];
  /** Time limit for one generation, in milliseconds. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Maximum number of concurrent Claude processes per tool process. Defaults to 4. */
  concurrency?: number;
  /**
   * Never call Claude; only use the cache, failing when it is missing or stale. Useful on CI.
   * Defaults to `true` when the `CONTENT_MAPPER_AUTO_OFFLINE` environment variable is `1`.
   */
  offline?: boolean;
}

/** Fully resolved configuration for one project. */
export interface ResolvedConfig {
  /** Absolute project root. Cache paths and prompts are relative to it. */
  root: string;
  /** Absolute cache directory. */
  cacheDir: string;
  model: string | undefined;
  instructions: string;
  claudeCommand: string[];
  tools: string[];
  timeoutMs: number;
  concurrency: number;
  offline: boolean;
}

export interface OptionProblem {
  /** Path inside the options object, e.g. `["tools", 1]`. */
  path: (string | number)[];
  message: string;
}

export const DEFAULT_CACHE_DIR = ".auto-cache";
export const DEFAULT_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_CONCURRENCY = 4;

/** Name of this package, as used in tsconfig `contentMappers` entries. */
export const PACKAGE_NAME = "content-mapper-auto";

/**
 * Validates an untrusted options object (from tsconfig or plugin options). Invalid properties are
 * dropped and reported, so a typo never prevents the rest of the configuration from working.
 */
export function validateOptions(raw: unknown): { options: AutoOptions; problems: OptionProblem[] } {
  const problems: OptionProblem[] = [];
  const options: AutoOptions = {};
  if (raw === undefined || raw === null) return { options, problems };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push({ path: [], message: "Options for content-mapper-auto must be an object." });
    return { options, problems };
  }
  const record = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    switch (key) {
      case "cacheDir":
      case "model":
      case "instructions":
        if (typeof value === "string" && (key === "instructions" || value !== "")) options[key] = value;
        else problems.push({ path: [key], message: `Option '${key}' must be a non-empty string.` });
        break;
      case "claudeCommand":
      case "tools": {
        if (!Array.isArray(value)) {
          problems.push({ path: [key], message: `Option '${key}' must be an array of strings.` });
          break;
        }
        const bad = value.findIndex((item) => typeof item !== "string" || item === "");
        if (bad !== -1) {
          problems.push({ path: [key, bad], message: `Option '${key}' must contain only non-empty strings.` });
        } else if (key === "claudeCommand" && value.length === 0) {
          problems.push({ path: [key], message: "Option 'claudeCommand' must not be empty." });
        } else {
          options[key] = value as string[];
        }
        break;
      }
      case "timeoutMs":
      case "concurrency":
        if (typeof value === "number" && Number.isInteger(value) && value > 0) options[key] = value;
        else problems.push({ path: [key], message: `Option '${key}' must be a positive integer.` });
        break;
      case "offline":
        if (typeof value === "boolean") options.offline = value;
        else problems.push({ path: [key], message: "Option 'offline' must be a boolean." });
        break;
      default:
        problems.push({ path: [key], message: `Unknown option '${key}'.` });
    }
  }
  return { options, problems };
}

function claudeCommandFromEnv(): string[] | undefined {
  const value = process.env.CONTENT_MAPPER_AUTO_CLAUDE;
  if (!value) return undefined;
  if (value.trimStart().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((s) => typeof s === "string")) {
        return parsed as string[];
      }
    } catch {
      // Fall through and treat the value as a plain path.
    }
  }
  return [value];
}

/** Combines validated options with defaults for a project rooted at `root`. */
export function resolveConfig(root: string, options: AutoOptions = {}): ResolvedConfig {
  const absoluteRoot = path.resolve(root);
  return {
    root: absoluteRoot,
    cacheDir: path.resolve(absoluteRoot, options.cacheDir ?? DEFAULT_CACHE_DIR),
    model: options.model,
    instructions: options.instructions ?? "",
    claudeCommand: options.claudeCommand ?? claudeCommandFromEnv() ?? ["claude"],
    tools: options.tools ?? [...DEFAULT_TOOLS],
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    offline: options.offline ?? process.env.CONTENT_MAPPER_AUTO_OFFLINE === "1",
  };
}

/**
 * Finds the root used when no tsconfig is involved: the nearest ancestor directory of `fromDir`
 * containing a package.json, or `fromDir` itself.
 */
export function findPackageRoot(fromDir: string): string {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(fromDir);
    dir = parent;
  }
}

/** Parses JSON with comments and trailing commas, as allowed in tsconfig files. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  // A comma is held back until the next significant character shows it is not a trailing comma.
  let pendingComma = false;
  const significant = (ch: string) => {
    if (pendingComma && ch !== "}" && ch !== "]") out += ",";
    pendingComma = false;
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      significant(ch);
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === ",") {
      significant(ch);
      pendingComma = true;
      i++;
    } else {
      if (!/\s/.test(ch)) significant(ch);
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
}

export interface TsconfigEntry {
  /** Absolute path of the tsconfig file that was read. */
  configFileName: string;
  /** The `options` of this package's `contentMappers` entry, if one was found (possibly via `extends`). */
  options: unknown;
  /** Extensions registered for this package, if an entry was found. */
  extensions: string[] | undefined;
}

/**
 * Reads the `contentMappers` entry for this package from a tsconfig file, following relative
 * `extends`. If the file itself has no entry, its project `references` are searched too (as in
 * solution-style configs), and the referenced config that has one is returned. Returns undefined
 * when the file does not exist.
 */
export function readTsconfigEntry(configFileName: string): TsconfigEntry | undefined {
  const own = readOwnTsconfigEntry(configFileName);
  if (!own || own.extensions) return own;
  try {
    const json = parseJsonc(readFileSync(own.configFileName, "utf8")) as Record<string, unknown>;
    for (const reference of Array.isArray(json.references) ? json.references : []) {
      const refPath = (reference as Record<string, unknown> | null)?.path;
      if (typeof refPath !== "string") continue;
      let file = path.resolve(path.dirname(own.configFileName), refPath);
      if (!file.endsWith(".json")) file = path.join(file, "tsconfig.json");
      const referenced = readOwnTsconfigEntry(file);
      if (referenced?.extensions) return referenced;
    }
  } catch {
    // Unreadable references are ignored; the content mapper will report config errors itself.
  }
  return own;
}

function readOwnTsconfigEntry(configFileName: string): TsconfigEntry | undefined {
  const absolute = path.resolve(configFileName);
  if (!existsSync(absolute)) return undefined;
  const seen = new Set<string>();
  const visit = (file: string): { options: unknown; extensions: string[] } | undefined => {
    if (seen.has(file) || !existsSync(file)) return undefined;
    seen.add(file);
    const json = parseJsonc(readFileSync(file, "utf8")) as Record<string, unknown>;
    const mappers = json.contentMappers;
    if (Array.isArray(mappers)) {
      for (const entry of mappers) {
        if (entry && typeof entry === "object" && (entry as Record<string, unknown>).package === PACKAGE_NAME) {
          const { options, extensions } = entry as Record<string, unknown>;
          return { options, extensions: Array.isArray(extensions) ? extensions.map(String) : [] };
        }
      }
      return undefined;
    }
    const parents = typeof json.extends === "string" ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
    // Later entries in an `extends` array take precedence.
    for (const parent of [...parents].reverse()) {
      if (typeof parent !== "string" || !parent.startsWith(".")) continue;
      let parentFile = path.resolve(path.dirname(file), parent);
      if (!parentFile.endsWith(".json")) parentFile += ".json";
      const found = visit(parentFile);
      if (found) return found;
    }
    return undefined;
  };
  const found = visit(absolute);
  return { configFileName: absolute, options: found?.options, extensions: found?.extensions };
}
