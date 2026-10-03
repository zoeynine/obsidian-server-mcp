import { readFile, writeFile } from "node:fs/promises";

const check = process.argv[2] === "--check";
if (process.argv.length > (check ? 3 : 2)) throw new Error("Usage: node scripts/generate-help.mjs [--check]");

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const topics = [];
const names = new Set();
let current;
let fence;
for (const line of readme.replace(/\r\n/g, "\n").split("\n")) {
  const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (fenceMatch) {
    if (!fence) fence = fenceMatch[1];
    else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = undefined;
    current?.lines.push(line);
    continue;
  }
  if (!fence) {
    const start = /^<!-- obsidian-help:([a-z][a-z0-9-]*) -->$/.exec(line);
    if (start) {
      if (current || names.has(start[1])) throw new Error("Nested or duplicate help topic: " + start[1]);
      current = { topic: start[1], lines: [] };
      names.add(start[1]);
      continue;
    }
    if (line === "<!-- /obsidian-help -->") {
      if (!current) throw new Error("Help topic end without start");
      const text = current.lines.join("\n").trim();
      const title = /^#{2,3} (.+)$/m.exec(text)?.[1];
      if (!title) throw new Error("Help topic needs a section heading: " + current.topic);
      topics.push({ topic: current.topic, title, text });
      current = undefined;
      continue;
    }
  }
  current?.lines.push(line);
}
if (current || topics.length === 0) throw new Error("Unclosed or missing README help topics");

const output = "// Generated from README.md by npm run generate:help. Do not edit directly.\n" +
  "export const HELP_TOPICS = " + JSON.stringify(topics, null, 2) + " as const;\n";
const destination = new URL("../src/transport/mcp/help-content.generated.ts", import.meta.url);
let existing;
try { existing = await readFile(destination, "utf8"); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const aligned = existing?.replace(/\r\n/g, "\n") === output;
if (check) {
  if (!aligned) throw new Error("Help content is stale; run npm run generate:help and commit the generated file.");
  console.log(`README help is aligned (${topics.length} topics).`);
} else if (!aligned) {
  await writeFile(destination, output, "utf8");
  console.log(`Generated ${topics.length} README help topics.`);
}
