import path from "node:path";
import { cacheKey, cachePathFor, formatCacheFile, normalizeDescription, readCache, relativeSourcePath, withCacheLock, writeCache } from "./cache.ts";
import type { ResolvedConfig } from "./config.ts";
import { GenerationError, generateWithClaude } from "./generate.ts";

export * from "./config.ts";
export { cacheKey, cachePathFor, GENERATOR_VERSION, readCache } from "./cache.ts";
export { GenerationError, SYSTEM_PROMPT } from "./generate.ts";

export interface LoadRequest {
  /** Absolute path of the .auto file. */
  fileName: string;
  /** Its current text (which may differ from disk, e.g. unsaved editor content). */
  content: string;
  config: ResolvedConfig;
  /**
   * Whether Claude may be called when the cache is not fresh. Defaults to `!config.offline`.
   */
  allowGenerate?: boolean;
  /** Called right before Claude is invoked (for logging). */
  onGenerate?: (sourcePath: string) => void;
}

export type LoadResult =
  /** The cache matched the description (`generated` tells whether Claude was just called for it). */
  | { status: "fresh"; code: string; cachePath: string; generated: boolean }
  /**
   * No up-to-date module is available. `code` is the outdated cached module, if any, which callers
   * may use as a fallback to keep types available.
   */
  | { status: "unavailable"; code: string | undefined; cachePath: string; reason: string; kind: UnavailableKind };

/** Why no up-to-date module is available. */
export type UnavailableKind = "empty" | "not-generated" | "failed";

/** Limits concurrent Claude processes within this process. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limit: () => number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    while (this.active >= this.limit()) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

let concurrencyLimit = 4;
const semaphore = new Semaphore(() => concurrencyLimit);
const inFlight = new Map<string, Promise<string>>();

/**
 * Returns the TypeScript module for a .auto file: from the shared cache when it is up to date,
 * otherwise by asking Claude (unless generation is disallowed) and storing the result in the cache.
 *
 * This is the single code path used by both the content mapper and the Vite plugin, so both always
 * see the same module for the same description.
 */
export async function loadAutoModule(request: LoadRequest): Promise<LoadResult> {
  const { fileName, content, config } = request;
  const allowGenerate = request.allowGenerate ?? !config.offline;
  const key = cacheKey(config, fileName, content);
  const cachePath = cachePathFor(config, fileName);
  const sourcePath = relativeSourcePath(config, fileName);

  const cached = await readCache(cachePath, key);
  if (cached.kind === "fresh") return { status: "fresh", code: cached.code, cachePath, generated: false };
  const fallback = cached.kind === "stale" ? cached.code : undefined;

  if (normalizeDescription(content).trim() === "") {
    return { status: "unavailable", code: fallback, cachePath, kind: "empty", reason: "The .auto file is empty; describe the module to generate." };
  }
  if (!allowGenerate) {
    const reason = config.offline
      ? `No up-to-date generated module for ${sourcePath} in ${path.relative(config.root, config.cacheDir) || "."} and generation is disabled (offline).`
      : `No up-to-date generated module for ${sourcePath}.`;
    return { status: "unavailable", code: fallback, cachePath, kind: "not-generated", reason };
  }

  const flightKey = `${cachePath}\0${key}`;
  let promise = inFlight.get(flightKey);
  if (!promise) {
    concurrencyLimit = config.concurrency;
    promise = withCacheLock(
      cachePath,
      key,
      config.timeoutMs + 60_000,
      async () => {
        const again = await readCache(cachePath, key);
        return again.kind === "fresh" ? again.code : undefined;
      },
      () =>
        semaphore.run(async () => {
          request.onGenerate?.(sourcePath);
          const code = await generateWithClaude(config, sourcePath, content);
          const text = formatCacheFile(sourcePath, key, code);
          await writeCache(cachePath, text);
          return text;
        }),
    ).finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, promise);
  }

  try {
    const code = await promise;
    return { status: "fresh", code, cachePath, generated: true };
  } catch (error) {
    const reason = error instanceof GenerationError ? error.message : `Generation failed: ${(error as Error).message ?? String(error)}`;
    return { status: "unavailable", code: fallback, cachePath, kind: "failed", reason };
  }
}
