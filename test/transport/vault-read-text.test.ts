import * as assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  VaultPathSandbox, VaultMutationStore, readVaultDocument,
  getVaultDocumentMap, listVaultFiles, listVaultTags, searchVaultQuery,
  type ReadVaultDocumentOptions,
} from "../../src/core/index.js";
import { readVaultNote } from "../../src/core/document/read-vault-note.js";
import { createVaultMcpServer } from "../../src/transport/mcp/server.js";

const source = '---\r\nflag: false\r\n---\r\n# 中文\r\n\r\n你好，世界 🌱\r\n字面 \\u4e2d 和 \\n。\r\n';

async function harness(t: TestContext, enableTextRead = true) {
  const vault = await mkdtemp(path.join(tmpdir(), "obsidian-text-read-"));
  t.after(() => rm(vault, { recursive: true, force: true }));
  await writeFile(path.join(vault, "note.md"), source, "utf8");
  const sandbox = await VaultPathSandbox.create(vault);
  const reader = (p: string, options?: ReadVaultDocumentOptions) => readVaultDocument(sandbox, p, options);
  const mutations = await VaultMutationStore.create(sandbox);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createVaultMcpServer({
    readDocument: (p, options) => readVaultNote(reader, p, options),
    getDocumentMap: (p, options) => getVaultDocumentMap(reader, p, options),
    listEntries: (p, options) => listVaultFiles(sandbox, p, options),
    searchQuery: (query, options) => searchVaultQuery(sandbox, reader, query, options),
    tagList: options => listVaultTags(sandbox, reader, options),
    mutations,
  }, enableTextRead ? { enableTextRead: true } : {}), { transport: serverTransport });
  const client = new Client({ name: "text-read-test", version: "1.0.0" });
  t.after(async () => { try { await client.close(); } finally { await handle.close(); } });
  await client.connect(clientTransport);
  await client.listTools();
  return { client, vault };
}

function textPayload(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block?.type === "text");
  return JSON.parse(block.text) as unknown;
}

test("text-read opt-in adds one tool and leaves every default declaration unchanged", async t => {
  const plain = await harness(t, false);
  const trial = await harness(t);
  const original = (await plain.client.listTools()).tools;
  const enabled = (await trial.client.listTools()).tools;
  assert.equal(original.some(tool => tool.name === "vault_read_text"), false);
  assert.deepEqual(enabled.filter(tool => tool.name !== "vault_read_text"), original);
  const text = enabled.find(tool => tool.name === "vault_read_text");
  const structured = enabled.find(tool => tool.name === "vault_read");
  assert.ok(text && structured);
  assert.equal(Object.hasOwn(text, "outputSchema"), false);
  assert.deepEqual(text.inputSchema, structured.inputSchema);
  assert.deepEqual(text.annotations, structured.annotations);
});

test("text-read preserves real reader payloads, Unicode, CRLF, literal escapes and typed targets", async t => {
  const { client } = await harness(t);
  const requests = [
    { path: "note.md" },
    { path: "note.md", targetType: "heading", target: ["中文"] },
    { path: "note.md", targetType: "frontmatter", target: "flag" },
  ];
  for (const args of requests) {
    const canonical = await client.callTool({ name: "vault_read", arguments: args });
    const text = await client.callTool({ name: "vault_read_text", arguments: args });
    assert.notEqual(text.isError, true);
    assert.deepEqual(textPayload(text), canonical.structuredContent);
  }
  const fullResult = await client.callTool({ name: "vault_read_text", arguments: { path: "note.md" } });
  const block = fullResult.content[0];
  assert.ok(block?.type === "text" && block.text.includes("你好，世界 🌱"));
  const full = textPayload(fullResult) as { content: string };
  assert.equal(full.content, source);
});

test("text-read preserves business errors and existing path and source-size guards", async t => {
  const { client } = await harness(t);
  for (const args of [
    { path: "missing.md" }, { path: "../outside.md" },
    { path: "note.md", maxBytes: 1 },
    { path: "note.md", targetType: "heading", target: ["不存在"] },
  ]) {
    const canonical = await client.callTool({ name: "vault_read", arguments: args });
    const text = await client.callTool({ name: "vault_read_text", arguments: args });
    assert.equal(canonical.isError, true);
    assert.equal(text.isError, true);
    assert.deepEqual(textPayload(text), canonical.structuredContent);
  }
  const invalid = await client.callTool({ name: "vault_read_text", arguments: { path: "note.md", force: true } });
  assert.equal(invalid.isError, true);
  assert.equal(Object.hasOwn(invalid, "structuredContent"), false);
});

test("text-read content and version work with the existing exact-replacement mutation", async t => {
  const { client, vault } = await harness(t);
  const read = textPayload(await client.callTool({ name: "vault_read_text", arguments: { path: "note.md" } })) as { content: string; version: string };
  assert.equal(read.content, source);
  const result = await client.callTool({ name: "vault_replace_text", arguments: {
    path: "note.md", oldText: "你好，世界 🌱", newText: "你好，朋友 🌱", ifMatch: read.version,
  } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), source.replace("你好，世界 🌱", "你好，朋友 🌱"));
});
