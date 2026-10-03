import * as assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { OBSIDIAN_HELP_TOOL_NAME } from "../../src/transport/mcp/server.js";
import { serveVaultMcpStdio } from "../../src/transport/mcp/stdio.js";
import { prepareVaultPatch } from "../../src/core/patch/prepare-vault-patch.js";
import { computeContentVersion } from "../../src/core/version/content-version.js";
import { parseVaultRelativePath } from "../../src/core/path/vault-path.js";

test("published patch examples execute against their stated note structure", async t => {
  const client = await createHelpClient(t);
  const response = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic: "patch" } });
  const text = (response.structuredContent as { text: string }).text;
  const examples = [...text.matchAll(/```json\n([\s\S]*?)\n```/gu)].map(match => JSON.parse(match[1]!));
  assert.equal(examples.length, 4);
  const source = "# Root\n\n## A\nOld body.\n\n## B\nKeep me.\n";
  const outputs = examples.map(({ path, ...instruction }) => {
    assert.equal(path, "note.md");
    assert.equal(instruction.ifMatch, "<current version>");
    const version = computeContentVersion(source);
    return prepareVaultPatch({ path: parseVaultRelativePath(path), content: source, version,
      sizeBytes: Buffer.byteLength(source), modifiedAtMs: 0 }, { ...instruction, ifMatch: version }).document;
  });
  assert.match(outputs[0]!, /## A\nNew body\./u);
  assert.match(outputs[0]!, /## B\nKeep me\./u);
  assert.match(outputs[1]!, /^---\nstatus: ready\n---\n/u);
  assert.match(outputs[2]!, /## A[\s\S]*## Inserted[\s\S]*## B/u);
  assert.match(outputs[3]!, /## B\nKeep me\.[\s\S]*### A\nOld body\./u);
  const existing = outputs[1]!.replace("status: ready", "status: draft");
  const version = computeContentVersion(existing);
  const { path: _path, ...setProperty } = examples[1];
  assert.equal(prepareVaultPatch({ path: parseVaultRelativePath("note.md"), content: existing, version,
    sizeBytes: Buffer.byteLength(existing), modifiedAtMs: 0 },
    { ...setProperty, ifMatch: version }).document, outputs[1]);
});

test("help discovers topics and returns only the requested section without Vault access", async t => {
  const client = await createHelpClient(t);
  const tool = (await client.listTools()).tools.find(entry => entry.name === OBSIDIAN_HELP_TOOL_NAME)!;
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["topic"]);
  assert.equal(tool.annotations?.readOnlyHint, true);
  assert.equal(tool.annotations?.destructiveHint, false);
  assert.equal(tool.annotations?.openWorldHint, false);

  const index = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: {} });
  assert.notEqual(index.isError, true);
  assert.deepEqual(index.content, []);
  const indexText = (index.structuredContent as { text: string }).text;
  assert.ok(indexText.length < 1000);
  assert.doesNotMatch(indexText, /```/u);
  const topics = ["read", "binary", "search", "references", "tags", "patch", "write", "paths", "files"];
  assert.deepEqual(indexText.split("\n").slice(1).map(line => line.split(":")[0]), topics);

  for (const topic of topics) {
    const result = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(result.content, []);
    const text = (result.structuredContent as { text: string }).text;
    assert.match(text, /^#{2,3} /u);
    assert.doesNotMatch(text, /obsidian-help:|# Obsidian Server MCP\n/u);
    if (topic === "patch") {
      assert.match(text, /"scope": "markerAndContent"/u);
      assert.match(text, /"scope": "parent"/u);
      assert.match(text, /targeted|Targeted/u);
      assert.doesNotMatch(text, /Moving and deleting files|Searching notes/u);
    }
  }
});

test("unknown help topics return a compact discoverable error and allow recovery", async t => {
  const client = await createHelpClient(t);
  for (const topic of ["missing", "", "__proto__", "constructor", "../../README.md"]) {
    const result = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic } });
    assert.equal(result.isError, true);
    const error = (result.structuredContent as { error: { code: string; message: string } }).error;
    assert.equal(error.code, "obsidian_help.unknown_topic");
    assert.match(error.message, /\npatch: /u);
    assert.ok(error.message.length < 1000);
    assert.doesNotMatch(error.message, /```/u);
  }
  const recovered = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic: "read" } });
  assert.notEqual(recovered.isError, true);
  assert.match((recovered.structuredContent as { text: string }).text, /vault_get_document_map/u);
});

test("help rejects malformed arguments and extra fields through the SDK", async t => {
  const client = await createHelpClient(t);
  for (const args of [{ topic: 1 }, { topic: ["patch"] }, { path: "private.md" }]) {
    const result = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: args });
    assert.equal(result.isError, true);
  }
});

async function createHelpClient(t: TestContext): Promise<Client> {
  let vaultCalls = 0;
  const unexpected = async (): Promise<never> => {
    vaultCalls++;
    throw new Error("Help must not call a Vault use case");
  };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveVaultMcpStdio({ getDocumentMap: unexpected, listEntries: unexpected,
    readDocument: unexpected, searchQuery: unexpected, tagList: unexpected }, { transport: serverTransport });
  const client = new Client({ name: "help-test", version: "1.0.0" });
  t.after(async () => {
    try { await client.close(); } finally { await handle.close(); }
    assert.equal(vaultCalls, 0);
  });
  await client.connect(clientTransport);
  return client;
}
