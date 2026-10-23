import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  VaultMutationStore, getVaultDocumentMap, listVaultFiles, listVaultTags, queryReferences,
  readVaultBinary, readVaultDocument, readVaultNote, searchVaultQuery,
} from "../../src/core/index.js";
import { computeContentVersion, getVersionGuard, InvalidVersionGuardError } from "../../src/core/version/content-version.js";
import { createVaultMcpServer, type VaultMcpServerDependencies } from "../../src/transport/mcp/server.js";
import { mapVaultMutationToolError } from "../../src/transport/mcp/vault-mutation-errors.js";
import { binaryFixture } from "../helpers/binary-fixture.js";
import { readToolError } from "./tool-error.js";

const source = "---\nstatus: draft\n---\n# Heading\nold\n";
const version = computeContentVersion(source);
const guard = getVersionGuard(version);
const mutations = [
  ["vault_write", { content: "replacement\n" }],
  ["vault_append", { content: "next" }],
  ["vault_patch", { targetType: "frontmatter", target: "status", operation: "replace", value: "done" }],
  ["vault_replace_text", { oldText: "old", newText: "new" }],
  ["vault_move", { destination: "moved.md" }],
  ["vault_delete", { permanent: true }],
] as const;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

async function fixture(t: TestContext) {
  const f = await binaryFixture(t);
  const reader = (input: string, options?: { maxBytes?: number }) => readVaultDocument(f.sandbox, input, options);
  const store = await VaultMutationStore.create(f.sandbox);
  const dependencies: VaultMcpServerDependencies = {
    readDocument: (input, options) => readVaultNote(reader, input, options),
    getDocumentMap: (input, options) => getVaultDocumentMap(reader, input, options),
    listEntries: (input, options) => listVaultFiles(f.sandbox, input, options),
    searchQuery: (query, options) => searchVaultQuery(f.sandbox, reader, query, options),
    tagList: options => listVaultTags(f.sandbox, reader, options),
    referenceQuery: input => queryReferences(f.sandbox, reader, input),
    readBinary: (input, options) => readVaultBinary(f.sandbox, input, options),
    mutations: store,
  };
  async function connect(text: boolean) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createVaultMcpServer(dependencies, text ? { toolProfile: "text" } : {}), { transport: serverTransport });
    const client = new Client({ name: "version-guard-test", version: "1.0.0" });
    t.after(async () => { try { await client.close(); } finally { await handle.close(); } });
    await client.connect(clientTransport);
    await client.listTools();
    return { client, text };
  }
  return { ...f, endpoints: [await connect(false), await connect(true)] };
}

function payload(result: ToolResult, text: boolean): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  if (!text) {
    assert.deepEqual(result.content, []);
    return result.structuredContent as Record<string, unknown>;
  }
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  const block = result.content[0];
  assert.ok(block?.type === "text");
  return JSON.parse(block.text) as Record<string, unknown>;
}

function assertGuard(value: Record<string, unknown>, expectedVersion = version): void {
  assert.equal(value["version"], expectedVersion);
  assert.equal(value["versionGuard"], getVersionGuard(expectedVersion));
  assert.match(String(value["versionGuard"]), /^[0-9a-f]{16}$/u);
}

test("all six mutation tools accept short guards with identical standard and text receipts", async t => {
  const f = await fixture(t);
  for (const [name, args] of mutations) {
    const receipts: Record<string, unknown>[] = [];
    for (const endpoint of f.endpoints) {
      await rm(path.join(f.vault, "moved.md"), { force: true });
      await writeFile(path.join(f.vault, "note.md"), source);
      const result = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args, ifMatchGuard: guard } });
      const receipt = payload(result, endpoint.text);
      assert.equal(receipt["message"], "OK");
      if (name === "vault_move" || name === "vault_delete") {
        assert.equal(Object.hasOwn(receipt, "version"), false);
        assert.equal(Object.hasOwn(receipt, "versionGuard"), false);
        await assert.rejects(readFile(path.join(f.vault, "note.md")), { code: "ENOENT" });
        if (name === "vault_move") assert.equal(await readFile(path.join(f.vault, "moved.md"), "utf8"), source);
      } else {
        const saved = await readFile(path.join(f.vault, "note.md"));
        assert.notDeepEqual(saved, Buffer.from(source));
        assertGuard(receipt, computeContentVersion(saved));
      }
      receipts.push(receipt);
    }
    assert.deepEqual(receipts[1], receipts[0], name);
  }
});

test("wrong, stale and dual preconditions produce the same compact errors for every mutation and profile", async t => {
  const f = await fixture(t);
  const wrongGuard = guard === "0000000000000000" ? "1111111111111111" : "0000000000000000";
  const sameGuardDifferentVersion = version.slice(0, -1) + (version.endsWith("0") ? "1" : "0");
  for (const [name, args] of mutations) {
    for (const endpoint of f.endpoints) {
      await writeFile(path.join(f.vault, "note.md"), source + "previous bytes\n");
      const before = payload(await endpoint.client.callTool({ name: endpoint.text ? "vault_read_text" : "vault_read",
        arguments: { path: "note.md" } }), endpoint.text);
      const staleGuard = before["versionGuard"];
      assert.notEqual(staleGuard, guard);
      await writeFile(path.join(f.vault, "note.md"), source);
      for (const expectedGuard of [wrongGuard, staleGuard]) {
        const result = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args, ifMatchGuard: expectedGuard } });
        const error = readToolError(result);
        assert.equal(error.code, "vault_mutation.version_conflict");
        assert.deepEqual(error.details, { path: "note.md", expectedGuard, actualGuard: guard });
        assert.equal(Object.hasOwn(result, "structuredContent"), false);
        assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), source);
      }
      const legacy = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args, ifMatch: sameGuardDifferentVersion } });
      assert.equal(readToolError(legacy).code, "vault_mutation.version_conflict");
      assert.deepEqual(readToolError(legacy).details, { path: "note.md", expected: sameGuardDifferentVersion, actual: version });
      assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), source);
      for (const ifMatchGuard of [guard, wrongGuard]) {
        const result = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args, ifMatch: version, ifMatchGuard } });
        const error = readToolError(result);
        assert.equal(error.code, "vault_mutation.conflicting_preconditions");
        assert.deepEqual(error.details, { path: "note.md" });
        assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), source);
      }
    }
  }
});

test("wire schemas keep fixed lowercase guard length and complete legacy versions separate", async t => {
  const f = await fixture(t);
  for (const endpoint of f.endpoints) {
    const tools = (await endpoint.client.listTools()).tools;
    for (const [name, args] of mutations) {
      const tool = tools.find(entry => entry.name === name)!;
      assert.equal((tool.inputSchema.properties?.["ifMatch"] as { pattern: string }).pattern, "^sha256:[0-9a-f]{64}$");
      assert.equal((tool.inputSchema.properties?.["ifMatchGuard"] as { pattern: string }).pattern, "^[0-9a-f]{16}$");
      await writeFile(path.join(f.vault, "note.md"), source);
      for (const ifMatchGuard of ["", "a", guard.slice(0, 15), guard + "0", guard + "\n", guard + "\r\n", "A".repeat(16), "g".repeat(16), version, null, 1]) {
        const result = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args, ifMatchGuard } });
        assert.equal(result.isError, true, JSON.stringify({ name, ifMatchGuard, result }));
        assert.match(JSON.stringify(result.content), /Input validation error/u);
      }
      for (const ifMatch of [guard, "sha256:" + guard, version.slice(0, -1), "sha256:" + "A".repeat(64)]) {
        const result = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args, ifMatch } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /Input validation error/u);
      }
      if (name === "vault_patch" || name === "vault_replace_text") {
        const result = await endpoint.client.callTool({ name, arguments: { path: "note.md", ...args } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /Input validation error/u);
      }
      assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), source);
    }
  }
  const mapped = mapVaultMutationToolError(new InvalidVersionGuardError("bad"), "note.md");
  assert.equal(readToolError(mapped).code, "vault_mutation.invalid_version_guard");
  assert.deepEqual(readToolError(mapped).details, { path: "note.md" });
});

test("reads, maps, search hits and references propagate matching guards in both profiles", async t => {
  const f = await fixture(t);
  const referenceSource = "[[note#Heading]] [[missing]]\n";
  await writeFile(path.join(f.vault, "note.md"), source);
  await writeFile(path.join(f.vault, "ref.md"), referenceSource);
  for (const endpoint of f.endpoints) {
    const names = endpoint.text ? ["vault_read_text", "vault_get_document_map_text", "search_query_text"]
      : ["vault_read", "vault_get_document_map", "search_query"];
    for (const selection of [{}, { targetType: "heading", target: ["Heading"] }, { targetType: "frontmatter", target: "status" }]) {
      const read = await endpoint.client.callTool({ name: names[0]!, arguments: { path: "note.md", ...selection } });
      assertGuard(payload(read, endpoint.text));
    }
    const map = await endpoint.client.callTool({ name: names[1]!, arguments: { path: "note.md" } });
    assertGuard(payload(map, endpoint.text));
    const search = payload(await endpoint.client.callTool({ name: names[2]!, arguments: { query: { "==": [{ var: "path" }, "note.md"] } } }), endpoint.text);
    const hits = search["results"] as Record<string, unknown>[];
    assert.equal(hits.length, 1);
    assertGuard(hits[0]!);
    for (const target of ["note.md", "missing.md"]) {
      const reference = payload(await endpoint.client.callTool({ name: "reference_query", arguments: {
        scope: { directory: "", recursive: true }, target: { path: target },
      } }), endpoint.text);
      const resolvedTarget = reference["target"] as Record<string, unknown>;
      if (target === "note.md") assertGuard(resolvedTarget);
      else {
        assert.equal(Object.hasOwn(resolvedTarget, "version"), false);
        assert.equal(Object.hasOwn(resolvedTarget, "versionGuard"), false);
      }
      const occurrences = [...reference["matches"] as { source: Record<string, unknown> }[],
        ...reference["uncertain"] as { source: Record<string, unknown> }[]];
      assert.ok(occurrences.length > 0);
      for (const occurrence of occurrences) assertGuard(occurrence.source, computeContentVersion(referenceSource));
    }
  }
});
