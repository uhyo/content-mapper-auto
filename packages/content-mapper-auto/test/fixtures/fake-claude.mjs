#!/usr/bin/env node
// A stand-in for the Claude CLI used by the tests. It accepts the same flags, reads the prompt from
// stdin and answers with `--output-format json` structured output. The description controls it:
//   - a line `code: <ts>` is returned verbatim as the module (several lines are joined),
//   - `FAIL` makes it report that the description cannot be implemented,
//   - `SLOW` makes it wait 1.5 s first.
// Every invocation is appended to $FAKE_CLAUDE_LOG (if set) as one JSON line.
import { appendFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const description = /<description>\n([\s\S]*)\n<\/description>/.exec(input)?.[1] ?? "";
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), source: process.env.CONTENT_MAPPER_AUTO_SOURCE, description }) + "\n");
}
if (description.includes("SLOW")) await new Promise((r) => setTimeout(r, 1500));

let output;
if (description.includes("FAIL")) {
  output = { code: "", error: "the description asks for something impossible" };
} else {
  const lines = description.split("\n").filter((l) => l.startsWith("code: ")).map((l) => l.slice(6));
  output = { code: lines.length ? lines.join("\n") : `export const description: string = ${JSON.stringify(description)};` };
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(output), structured_output: output }));
