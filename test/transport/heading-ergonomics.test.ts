import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  VaultMutationStore, VaultPathSandbox, computeContentVersion, getVersionGuard,
  getVaultDocumentMap, listVaultFiles, listVaultTags, readVaultDocument, readVaultNote, searchVaultQuery,
  type ReadVaultDocumentOptions,
} from "../../src/core/index.js";
import { createVaultMcpServer, type VaultMcpServerDependencies, type VaultMcpServerOptions } from "../../src/transport/mcp/server.js";
import { readToolError } from "./tool-error.js";

type Profile = "standard" | "text" | "legacy";
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
interface Endpoint { readonly client: Client; readonly profile: Profile }
const profiles: readonly Profile[] = ["standard", "text", "legacy"];
const note = "note.md";
const readName = (profile: Profile): string => profile === "standard" ? "vault_read" : "vault_read_text";
const mapName = (profile: Profile): string => profile === "text" ? "vault_get_document_map_text" : "vault_get_document_map";

async function fixture(t: TestContext) {
  const workspace = path.resolve(".test-dist");
  await mkdir(workspace, { recursive: true });
  const vault = await mkdtemp(path.join(workspace, "heading-transport-"));
  const endpoints: { close(): Promise<void> }[] = [];
  t.after(async () => {
    try { for (const endpoint of endpoints) await endpoint.close(); }
    finally {
      const relative = path.relative(workspace, vault);
      assert.ok(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
      await rm(vault, { recursive: true, force: true });
    }
  });
  const sandbox = await VaultPathSandbox.create(vault);
  const reader = (input: string, options?: ReadVaultDocumentOptions) => readVaultDocument(sandbox, input, options);
  const mutations = await VaultMutationStore.create(sandbox);
  const reads: VaultMcpServerDependencies = {
    readDocument: (input, options) => readVaultNote(reader, input, options),
    getDocumentMap: (input, options) => getVaultDocumentMap(reader, input, options),
    listEntries: (input, options) => listVaultFiles(sandbox, input, options),
    searchQuery: (query, options) => searchVaultQuery(sandbox, reader, query, options),
    tagList: options => listVaultTags(sandbox, reader, options),
  };
  async function open(profile: Profile, writable = true): Promise<Endpoint> {
    const options: VaultMcpServerOptions = profile === "text" ? { toolProfile: "text" }
      : profile === "legacy" ? { enableTextRead: true } : {};
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createVaultMcpServer(writable ? { ...reads, mutations } : reads, options), { transport: serverTransport });
    const client = new Client({ name: "heading-ergonomics-test", version: "1.0.0" });
    endpoints.push({ async close() { try { await client.close(); } finally { await handle.close(); } } });
    await client.connect(clientTransport);
    await client.listTools();
    return { client, profile };
  }
  return { vault, open };
}

function payload(result: ToolResult, endpoint: Endpoint, targetedRead = false): Record<string, unknown> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  if (endpoint.profile === "standard" || endpoint.profile === "legacy" && !targetedRead) {
    assert.deepEqual(result.content, []);
    return result.structuredContent as Record<string, unknown>;
  }
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  const first = result.content[0];
  assert.ok(first?.type === "text");
  const metadata = JSON.parse(first.text) as Record<string, unknown>;
  assert.equal(first.text, JSON.stringify(metadata));
  if (endpoint.profile === "text" && targetedRead) {
    assert.equal(result.content.length, 2);
    assert.equal(metadata["textField"], "result");
    const body = result.content[1];
    assert.ok(body?.type === "text");
    const { textField: _textField, ...rest } = metadata;
    return { ...rest, result: body.text };
  }
  assert.equal(result.content.length, 1);
  return metadata;
}

// Establish that every presentation reaches the same resolver and preserves exact read results.
test("unique heading strings preserve relative scopes, exact paths and versions across all read presentations", async t => {
  const f = await fixture(t);
  const source = "\uFEFF# Root\r\n## 唯一 🌱\r\n正文\r\n### Child\r\n后代\r\n# Outside\r\nstay\r\n";
  await writeFile(path.join(f.vault, note), source);
  for (const profile of profiles) {
    const endpoint = await f.open(profile);
    for (const scope of ["content", "marker", "markerAndContent"]) {
      const args = { path: note, targetType: "heading", scope };
      const exact = payload(await endpoint.client.callTool({ name: readName(profile),
        arguments: { ...args, target: ["Root", "唯一 🌱"] } }), endpoint, true);
      const shorthand = payload(await endpoint.client.callTool({ name: readName(profile),
        arguments: { ...args, target: "唯一 🌱" } }), endpoint, true);
      assert.deepEqual(shorthand, exact, `${profile} ${scope}`);
      assert.equal(shorthand["version"], computeContentVersion(source));
      assert.equal(shorthand["versionGuard"], getVersionGuard(computeContentVersion(source)));
      if (scope === "content") assert.equal(shorthand["result"], "正文\r\n# Child\r\n后代\r\n");
      if (scope === "marker") assert.equal(shorthand["result"], "唯一 🌱");
    }
  }
});

// Ambiguity must be actionable rather than choosing the first visible match.
test("ambiguous heading strings return exact recoverable duplicate paths without changing array or patch addressing", async t => {
  const f = await fixture(t);
  const source = "# Root\n## Same\nfirst\n## Same\nsecond\n# Same\ntop\n";
  await writeFile(path.join(f.vault, note), source);
  for (const profile of profiles) {
    const endpoint = await f.open(profile);
    const map = payload(await endpoint.client.callTool({ name: mapName(profile), arguments: { path: note } }), endpoint);
    const root = (map["headings"] as Record<string, Record<string, unknown>>)["Root"]!;
    const duplicateKeys = Object.keys(root);
    assert.equal(duplicateKeys.length, 2);
    assert.notEqual(duplicateKeys[0], duplicateKeys[1]);
    const result = await endpoint.client.callTool({ name: readName(profile),
      arguments: { path: note, targetType: "heading", target: "Same" } });
    const error = readToolError(result);
    assert.equal(error.code, "vault_semantic.ambiguous_heading");
    const candidates = [["Root", duplicateKeys[0]!], ["Root", duplicateKeys[1]!], ["Same"]];
    assert.deepEqual(error.details, { candidates, total: 3, truncated: false });
    for (const [index, target] of candidates.entries()) {
      const recovered = payload(await endpoint.client.callTool({ name: readName(profile),
        arguments: { path: note, targetType: "heading", target } }), endpoint, true);
      assert.equal(recovered["result"], ["first\n", "second\n", "top\n"][index]);
    }
    for (const target of [["Same"], '["Same"]']) {
      const exact = payload(await endpoint.client.callTool({ name: readName(profile),
        arguments: { path: note, targetType: "heading", target } }), endpoint, true);
      assert.equal(exact["result"], "top\n");
    }
    const missing = await endpoint.client.callTool({ name: readName(profile),
      arguments: { path: note, targetType: "heading", target: "Missing" } });
    const missingError = readToolError(missing);
    assert.equal(missingError.code, "vault_semantic.TargetNotFoundError");
    assert.match(missingError.message, /case-sensitively/u);
    assert.match(missingError.message, /#anchor and file#anchor syntax is not resolved/u);
    const patch = await endpoint.client.callTool({ name: "vault_patch", arguments: {
      path: note, targetType: "heading", target: "Same", operation: "replace", scope: "marker", content: "Renamed",
      ifMatch: computeContentVersion(source),
    } });
    const patchError = readToolError(patch);
    assert.equal(patchError.code, "vault_semantic.invalid_instruction");
    assert.match(patchError.message, /exact full path array/u);
    assert.match(patchError.message, /shorthand is available only for reads/u);
    assert.equal(await readFile(path.join(f.vault, note), "utf8"), source);
  }
});

// Exercise the public tool through the shared store; stored levels are the observable result.
test("structured insertion registers only with mutations and returns versioned receipts with server-computed levels", async t => {
  const f = await fixture(t);
  const source = "\uFEFF# Root\r\nintro ^intro\r\n### Parent\r\nparent\r\n#### Existing\r\nkeep\r\n# Outside\r\nstay\r\n";
  let schema: unknown;
  for (const profile of profiles) {
    const endpoint = await f.open(profile);
    const tool = (await endpoint.client.listTools()).tools.find(entry => entry.name === "vault_insert_heading");
    assert.ok(tool);
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.destructiveHint, false);
    assert.equal(tool.annotations?.idempotentHint, false);
    assert.equal(tool.inputSchema["additionalProperties"], false);
    assert.equal(Object.hasOwn(tool, "outputSchema"), profile !== "text");
    if (profile !== "text") {
      const output = tool.outputSchema!;
      const properties = output["properties"] as Record<string, Record<string, unknown>>;
      const required = output["required"];
      assert.ok(Array.isArray(required));
      assert.ok(required.includes("headingPath"));
      assert.ok(required.includes("headingLevel"));
      assert.equal(properties["headingPath"]!["type"], "array");
      assert.equal(properties["headingPath"]!["minItems"], 1);
      assert.deepEqual(properties["headingPath"]!["items"], { type: "string" });
      assert.equal(properties["headingLevel"]!["type"], "integer");
      assert.equal(properties["headingLevel"]!["minimum"], 1);
      assert.equal(properties["headingLevel"]!["maximum"], 6);
    }
    if (schema === undefined) schema = tool.inputSchema;
    else assert.deepEqual(tool.inputSchema, schema);
    await writeFile(path.join(f.vault, note), source);
    const args = { path: note, parent: ["Root", "Parent"], place: { after: ["Root", "Parent", "Existing"] },
      title: "新增 🌱", body: "literal body\r\n\r\n# Child\r\nchild body\r\n\r\n## Grandchild\r\ngrandchild body\r\n", ifMatchGuard: getVersionGuard(computeContentVersion(source)) };
    const receipt = payload(await endpoint.client.callTool({ name: "vault_insert_heading", arguments: args }), endpoint);
    const saved = await readFile(path.join(f.vault, note), "utf8");
    assert.match(saved, /\r\n#### 新增 🌱\r\n/u);
    assert.match(saved, /\r\n##### Child\r\nchild body\r\n\r\n###### Grandchild\r\ngrandchild body\r\n/u);
    assert.ok(saved.startsWith(source.slice(0, source.indexOf("# Outside"))));
    assert.ok(saved.endsWith("# Outside\r\nstay\r\n"));
    const map = payload(await endpoint.client.callTool({ name: mapName(profile), arguments: { path: note } }), endpoint);
    assert.deepEqual(JSON.parse(JSON.stringify(map["headings"])), {
      Root: { Parent: { Existing: {}, "新增 🌱": { Child: { Grandchild: {} } } } }, Outside: {},
    });
    assert.equal(receipt["beforeSizeBytes"], Buffer.byteLength(source));
    assert.equal(receipt["sizeBytes"], Buffer.byteLength(saved));
    assert.equal(receipt["version"], computeContentVersion(saved));
    assert.equal(receipt["versionGuard"], getVersionGuard(computeContentVersion(saved)));
    assert.equal(receipt["created"], false);
    assert.deepEqual(receipt["headingPath"], ["Root", "Parent", "新增 🌱"]);
    assert.equal(receipt["headingLevel"], 4);
    const located = payload(await endpoint.client.callTool({ name: readName(profile), arguments: {
      path: note, targetType: "heading", target: receipt["headingPath"], scope: "marker",
    } }), endpoint, true);
    assert.equal(located["result"], "新增 🌱");
    assert.equal(located["version"], receipt["version"]);
    const stale = await endpoint.client.callTool({ name: "vault_insert_heading", arguments: { ...args, title: "Another" } });
    assert.equal(readToolError(stale).code, "vault_mutation.version_conflict");
    assert.equal(await readFile(path.join(f.vault, note), "utf8"), saved);
    const readOnly = await f.open(profile, false);
    assert.equal((await readOnly.client.listTools()).tools.some(entry => entry.name === "vault_insert_heading"), false);
  }
});

// Verify transport rejects malformed shapes and preserves each core refusal without publishing bytes.
test("structured insertion validates strict inputs and exposes safe failure codes in every presentation", async t => {
  const f = await fixture(t);
  const source = "# Root\n## Existing\nkeep\n";
  for (const profile of profiles) {
    const endpoint = await f.open(profile);
    await writeFile(path.join(f.vault, note), source);
    const base = { path: note, parent: ["Root"], place: "last", title: "New", body: "body", ifMatch: computeContentVersion(source) };
    const { ifMatch: _ifMatch, ...withoutPrecondition } = base;
    for (const args of [
      { ...base, parent: "Root" }, { ...base, place: { before: "Existing" } },
      { ...base, place: { before: ["Root", "Existing"], after: ["Root", "Existing"] } },
      { ...base, title: 1 }, { ...base, body: [] }, { ...base, unknown: true }, withoutPrecondition,
    ]) {
      const result = await endpoint.client.callTool({ name: "vault_insert_heading", arguments: args });
      assert.equal(result.isError, true);
      assert.equal(Object.hasOwn(result, "structuredContent"), false);
      assert.match(JSON.stringify(result.content), /Input validation error/u);
      assert.equal(await readFile(path.join(f.vault, note), "utf8"), source);
    }
    const refusals = [
      { source, instruction: { parent: ["Missing"] }, code: "TargetNotFoundError" },
      { source, instruction: { place: { before: ["Root", "Missing"] } }, code: "TargetNotFoundError" },
      { source: "# Root\n## A\n### A\nnested body\n## B\nkeep\n",
        instruction: { place: { before: ["Root", "A", "A"] } }, code: "TargetNotFoundError" },
      { source, instruction: { title: "Existing" }, code: "duplicate_heading" },
      { source, instruction: { body: "# 2\none\n# 2\ntwo" }, code: "duplicate_heading" },
      { source, instruction: { body: "two\nlines\n====\nbody" }, code: "unsupported_heading" },
      { source: "###### Deep\nbody\n", instruction: { parent: ["Deep"] }, code: "heading_depth_overflow" },
      { source: "##### Parent\nbody\n", instruction: { parent: ["Parent"], body: "# Child\nbody" }, code: "heading_depth_overflow" },
      { source: "# Root\n### Existing\nkeep\n", instruction: { place: "first" }, code: "unsafe_heading_insertion" },
    ];
    for (const refusal of refusals) {
      await writeFile(path.join(f.vault, note), refusal.source);
      const result = await endpoint.client.callTool({ name: "vault_insert_heading", arguments: {
        ...base, ...refusal.instruction, ifMatch: computeContentVersion(refusal.source),
      } });
      const error = readToolError(result);
      assert.equal(error.code, "vault_semantic." + refusal.code);
      if (refusal.code === "TargetNotFoundError") {
        assert.match(error.message, /exact full paths/u);
        assert.match(error.message, /direct child/u);
        assert.ok(error.message.includes("from " + mapName(profile) + "."));
        assert.doesNotMatch(error.message, /within|raw heading label|string target|shorthand/u);
      }
      assert.deepEqual(await readFile(path.join(f.vault, note)), Buffer.from(refusal.source));
    }
  }
});

// Published examples must perform the advertised placement with tokens returned by this server.
test("published insertion examples preserve their parent and placement intent in standard and text tools", async t => {
  const f = await fixture(t);
  const source = "# Root\nintro\n## A\nkeep A\n## B\nkeep B\n";
  for (const profile of ["standard", "text"] as const) {
    const endpoint = await f.open(profile);
    const help = payload(await endpoint.client.callTool({ name: "obsidian_help", arguments: { topic: "vault_insert_heading" } }), endpoint);
    assert.equal(typeof help["text"], "string");
    const examples = [...(help["text"] as string).matchAll(/```json\n([\s\S]*?)\n```/gu)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>);
    assert.equal(examples.length, 2);
    for (const [index, example] of examples.entries()) {
      await writeFile(path.join(f.vault, note), source);
      const current = payload(await endpoint.client.callTool({ name: mapName(profile), arguments: { path: note } }), endpoint);
      const precondition = "ifMatchGuard" in example ? { ifMatchGuard: current["versionGuard"] } : { ifMatch: current["version"] };
      const receipt = payload(await endpoint.client.callTool({ name: "vault_insert_heading",
        arguments: { ...example, ...precondition } }), endpoint);
      const saved = await readFile(path.join(f.vault, note), "utf8");
      assert.equal(receipt["version"], computeContentVersion(saved));
      assert.deepEqual(receipt["headingPath"], index === 0 ? ["Root", "Inserted"] : ["Appendix"]);
      assert.equal(receipt["headingLevel"], index === 0 ? 2 : 1);
      const map = payload(await endpoint.client.callTool({ name: mapName(profile), arguments: { path: note } }), endpoint);
      assert.deepEqual(JSON.parse(JSON.stringify(map["headings"])), index === 0
        ? { Root: { A: {}, Inserted: { Details: { Notes: {} } }, B: {} } }
        : { Root: { A: {}, B: {} }, Appendix: {} });
      assert.match(saved, /keep A\n/u);
      assert.match(saved, /keep B\n/u);
      if (index === 0) assert.match(saved, /## Inserted\n\nNew section body\.\n\n### Details\nChild body\.\n\n#### Notes\nNested body\./u);
      else assert.match(saved, /# Appendix\n/u);
    }
  }
});
