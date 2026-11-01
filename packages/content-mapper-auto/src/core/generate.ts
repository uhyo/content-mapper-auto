import { spawn } from "node:child_process";
import type { ResolvedConfig } from "./config.ts";

export const SYSTEM_PROMPT = `You are the code generator behind content-mapper-auto, a TypeScript content mapper.
A ".auto" file contains a plain-language description of a TypeScript module. Your job is to write that module.

Rules:
- Return the complete TypeScript source of the module in the "code" field of the structured output. No markdown fences, no commentary outside of code comments.
- The code must be a valid ES module that type-checks under "strict": true with "verbatimModuleSyntax": true and "isolatedModules": true. Use "import type" for type-only imports.
- Export exactly what the description asks for, with the names it gives. Give every exported declaration an explicit type annotation (parameters and return types of exported functions, types of exported constants). Add a short JSDoc comment to each export.
- The module is evaluated at the location of the .auto file, so relative imports resolve from that file's directory. Refer to other project modules with the import specifier style the project already uses.
- You may use the Read, Glob and Grep tools to inspect the project when the description refers to existing types or modules, but never modify files. Do not explore more than needed.
- Do not import third-party packages unless the description asks for them and they are listed in the project's package.json. Prefer platform APIs available in both browsers and Node.js unless the description says otherwise.
- Keep the implementation self-contained, correct, and idiomatic. Handle the edge cases the description implies.
- If the description is empty, contradictory, or cannot reasonably be implemented, set "code" to "" and explain the problem briefly in "error".`;

export const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", description: "Complete TypeScript source of the module." },
    error: { type: "string", description: "Set only when the module cannot be generated." },
  },
  required: ["code"],
  additionalProperties: false,
} as const;

export function buildPrompt(sourcePath: string, description: string, instructions: string): string {
  const parts = [
    `Generate the TypeScript module described by the file "${sourcePath}" (path relative to the project root, which is the current directory).`,
  ];
  if (instructions.trim() !== "") {
    parts.push(`Project-wide instructions:\n${instructions.trim()}`);
  }
  parts.push(`<description>\n${description.trim()}\n</description>`);
  return parts.join("\n\n");
}

export class GenerationError extends Error {
  override name = "GenerationError";
}

interface ClaudeJsonResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: { code?: unknown; error?: unknown };
}

/** Removes a surrounding markdown code fence, in case the model added one anyway. */
export function stripCodeFence(code: string): string {
  const match = /^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/.exec(code);
  return match ? match[1]! : code;
}

function parseClaudeOutput(stdout: string): string {
  let parsed: ClaudeJsonResult;
  try {
    parsed = JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    throw new GenerationError(`Could not parse the Claude CLI output: ${stdout.slice(0, 500)}`);
  }
  if (parsed.is_error || (parsed.subtype && parsed.subtype !== "success")) {
    throw new GenerationError(`Claude CLI reported an error (${parsed.subtype ?? "error"}): ${parsed.result ?? ""}`.trim());
  }
  let output = parsed.structured_output;
  if (!output && typeof parsed.result === "string") {
    try {
      output = JSON.parse(parsed.result) as ClaudeJsonResult["structured_output"];
    } catch {
      output = { code: parsed.result };
    }
  }
  const error = typeof output?.error === "string" ? output.error.trim() : "";
  const code = typeof output?.code === "string" ? stripCodeFence(output.code).trim() : "";
  if (code === "") {
    throw new GenerationError(error !== "" ? `Claude could not implement the description: ${error}` : "Claude returned no code.");
  }
  return code + "\n";
}

/**
 * Runs the Claude CLI in print mode to turn a description into TypeScript source. The CLI runs in
 * the project root with read-only tools, so it can look at the types and modules the description
 * mentions.
 */
export function generateWithClaude(
  config: ResolvedConfig,
  sourcePath: string,
  description: string,
  signal?: AbortSignal,
): Promise<string> {
  const [command, ...prefix] = config.claudeCommand;
  const args = [
    ...prefix,
    "--print",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(OUTPUT_SCHEMA),
    "--system-prompt",
    SYSTEM_PROMPT,
    "--tools",
    config.tools.join(","),
    "--no-session-persistence",
  ];
  if (config.tools.length > 0) args.push("--allowedTools", config.tools.join(","));
  if (config.model) args.push("--model", config.model);

  return new Promise((resolve, reject) => {
    const child = spawn(command!, args, {
      cwd: config.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CONTENT_MAPPER_AUTO_SOURCE: sourcePath },
      signal,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new GenerationError(`Claude CLI timed out after ${config.timeoutMs} ms.`));
    }, config.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      const notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
      reject(
        new GenerationError(
          notFound
            ? `Could not run the Claude CLI (${command}). Install Claude Code or set the 'claudeCommand' option.`
            : `Could not run the Claude CLI: ${error.message}`,
        ),
      );
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (exitCode !== 0 && stdout.trim() === "") {
        reject(new GenerationError(`Claude CLI exited with code ${exitCode}: ${stderr.trim().slice(0, 1000)}`));
        return;
      }
      try {
        resolve(parseClaudeOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {
      // The process may exit before reading its input; the close handler reports that.
    });
    child.stdin.end(buildPrompt(sourcePath, description, config.instructions));
  });
}
