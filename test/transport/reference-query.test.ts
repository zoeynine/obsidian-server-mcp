import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { binaryClient, binaryFixture } from "../helpers/binary-fixture.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { REFERENCE_QUERY_TOOL_NAME } from "../../src/transport/mcp/reference-query.js";
import type { ReferenceQueryResult } from "../../src/core/reference/types.js";

const tool = REFERENCE_QUERY_TOOL_NAME;
const args = { scope: { directory: "", recursive: true }, target: { path: "Note.md" } };
test("stock stdio executes the new reference tool against a disposable Vault", async t => {
  const f = await binaryFixture(t);
  await writeFile(path.join(f.vault, "Note.md"), "# Title\n[[#Title]]\n");
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(".test-dist/src/stdio-main.js")], env: { OBSIDIAN_VAULT_ROOT: f.vault }, stderr: "pipe" });
  const client = new Client({ name: "reference-stdio-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 13);
  const response = await client.callTool({ name: tool, arguments: args });
  assert.notEqual(response.isError, true);
  assert.equal((response.structuredContent as unknown as ReferenceQueryResult).matches[0]!.raw, "[[#Title]]");
});
test("reference query adds a strictly typed read-only tool alongside the unchanged twelve-tool baseline", async t => {
  const old = await binaryClient(t);
  const current = await binaryClient(t, { referenceQuery: true });
  const before = (await old.client.listTools()).tools;
  const after = (await current.client.listTools()).tools;
  assert.equal(before.length, 12);
  assert.equal(after.length, 13);
  for (const entry of before) assert.deepEqual(after.find(item => item.name === entry.name), entry);
  const entry = after.find(item => item.name === tool)!;
  assert.deepEqual(entry.inputSchema.required, ["scope", "target"]);
  assert.ok(entry.outputSchema);
  assert.deepEqual(entry.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  await writeFile(path.join(current.vault, "Note.md"), "# Title\n");
  await writeFile(path.join(current.vault, "ref.md"), "[[Note#Title|label]]");
  const response = await current.client.callTool({ name: tool, arguments: args });
  assert.notEqual(response.isError, true);
  assert.deepEqual(response.content, []);
  const result = response.structuredContent as unknown as ReferenceQueryResult;
  assert.equal(result.matches[0]!.raw, "[[Note#Title|label]]");
  assert.equal(result.matches[0]!.source.path, "ref.md");
  assert.equal(result.coverage.offsetUnit, "utf16");
});

test("reference wire rejects missing, malformed, oversized and unknown inputs before running core", async t => {
  let calls = 0;
  const { client } = await binaryClient(t, { referenceQuery: async () => { calls++; throw new Error("should not run"); } });
  for (const input of [{}, { target: args.target }, { ...args, scope: { directory: "" } },
    { ...args, scope: { directory: "", recursive: "true" } }, { ...args, target: { path: "x", extra: true } },
    { ...args, extra: true }, { ...args, maxFiles: 10001 }, { ...args, maxOutputBytes: 0 }, { ...args, target: { path: "x", heading: [] } }]) {
    assert.equal((await client.callTool({ name: tool, arguments: input })).isError, true);
  }
  assert.equal(calls, 0);
});

test("reference query errors are compact, stable and do not disclose unexpected roots or stacks", async t => {
  const real = await binaryClient(t, { referenceQuery: true });
  await writeFile(path.join(real.vault, "Note.md"), "# Title\n");
  await writeFile(path.join(real.vault, "ref.md"), "[[Note]] [[Note]]");
  for (const [input, code] of [[{ ...args, maxResults: 1 }, "reference_query.budget_exceeded"],
    [{ ...args, target: { path: "../outside.md" } }, "vault_path.parent_traversal"],
    [{ ...args, target: { path: "Note.md", heading: ["Title"], block: "id" } }, "reference_query.invalid_input"]] as const) {
    const response = await real.client.callTool({ name: tool, arguments: input });
    assert.equal(response.isError, true);
    assert.equal((response.structuredContent as { error: { code: string } }).error.code, code);
    assert.ok(!JSON.stringify(response).includes(real.vault));
  }
  const broken = await binaryClient(t, { referenceQuery: async () => { throw new Error("SECRET_HOST_ROOT stack"); } });
  const response = await broken.client.callTool({ name: tool, arguments: args });
  assert.equal(response.isError, true);
  assert.equal((response.structuredContent as { error: { code: string } }).error.code, "reference_query.internal_error");
  assert.doesNotMatch(JSON.stringify(response), /SECRET_HOST_ROOT|stack/u);
});
