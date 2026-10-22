import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import sharp from "sharp";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  VaultMutationStore, VaultPathSandbox, computeContentVersion, getVaultDocumentMap,
  listVaultFiles, listVaultTags, queryReferences, readVaultBinary, readVaultDocument,
  readVaultNote, searchVaultQuery, type ReadVaultDocumentOptions,
} from "../../src/core/index.js";
import {
  createVaultMcpServer, type VaultMcpServerDependencies, type VaultMcpServerOptions,
} from "../../src/transport/mcp/server.js";
import { readToolErrorPayload } from "./tool-error.js";

const directory = "资料目录 🌱";
const notePath = `${directory}/中文笔记 🌫️.md`;
const heading = "中文标题 🌱";
const literalHeading = String.raw`字面 \u4e2d 和 \n`;
const label = String.raw`中文 🌱 \u4e2d 和 \n`;
const source = "\uFEFF---\r\n" + `标题: '${label}'\r\n` +
  "priority: 7\r\nitems: [一, 二]\r\nmeta: {状态: 就绪, active: false}\r\n---\r\n" +
  `# ${heading}\r\n## 重复\r\n第一处 🌱 ^first-id\r\n\r\n` +
  `## 重复\r\n第二处 🌫️\r\n## ${literalHeading}\r\n字面正文 \\u4e2d 和 \\n。\r\n`;
const textTools = [
  ["vault_read", "vault_read_text"],
  ["vault_list", "vault_list_text"],
  ["vault_get_document_map", "vault_get_document_map_text"],
  ["search_query", "search_query_text"],
] as const;
const textNames = new Set<string>(textTools.map(([, name]) => name));
const structuredNames = new Set<string>(textTools.map(([name]) => name));

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

async function fixture(t: TestContext) {
  const workspace = path.resolve(".test-dist");
  await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(path.join(workspace, "vault-text-tools-"));
  const vault = path.join(root, "vault");
  const endpoints: { close(): Promise<void> }[] = [];
  t.after(async () => {
    try {
      for (const endpoint of endpoints) await endpoint.close();
    } finally {
      const relative = path.relative(workspace, root);
      assert.ok(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(path.join(vault, directory), { recursive: true });
  await writeFile(path.join(vault, notePath), source, "utf8");
  await writeFile(path.join(vault, directory, "另一篇.md"), "# 其他\r\n另一篇正文\r\n", "utf8");
  await writeFile(path.join(vault, directory, "附件.bin"), Buffer.from([0, 0xff, 1]));
  const sandbox = await VaultPathSandbox.create(vault);
  const reader = (input: string, options?: ReadVaultDocumentOptions) => readVaultDocument(sandbox, input, options);
  const dependencies: VaultMcpServerDependencies = {
    readDocument: (input, options) => readVaultNote(reader, input, options),
    getDocumentMap: (input, options) => getVaultDocumentMap(reader, input, options),
    listEntries: (input, options) => listVaultFiles(sandbox, input, options),
    searchQuery: (query, options) => searchVaultQuery(sandbox, reader, query, options),
    tagList: options => listVaultTags(sandbox, reader, options),
    referenceQuery: input => queryReferences(sandbox, reader, input),
    readBinary: (input, options) => readVaultBinary(sandbox, input, options),
    mutations: await VaultMutationStore.create(sandbox),
  };
  async function openServer(options: VaultMcpServerOptions = {}, overrides: Partial<VaultMcpServerDependencies> = {}) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createVaultMcpServer({ ...dependencies, ...overrides }, options), { transport: serverTransport });
    const client = new Client({ name: "vault-text-tools-test", version: "1.0.0" });
    let closed = false;
    const endpoint = { client, async close() {
      if (closed) return;
      closed = true;
      try { await client.close(); } finally { await handle.close(); }
    } };
    endpoints.push(endpoint);
    await client.connect(clientTransport);
    await client.listTools();
    return endpoint;
  }
  const standard = await openServer();
  const compatibility = await openServer({ toolProfile: "text" });
  return { root, vault, standard, compatibility, openServer };
}

function textPayload(result: ToolResult): unknown {
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block?.type === "text");
  const payload = JSON.parse(block.text) as unknown;
  assert.equal(block.text, JSON.stringify(payload));
  return payload;
}

function rawTextPayload(result: ToolResult): { metadata: Record<string, unknown>; body: string } {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  assert.equal(result.content.length, 2);
  const [metadata, body] = result.content;
  assert.ok(metadata?.type === "text" && body?.type === "text");
  const payload = JSON.parse(metadata.text) as Record<string, unknown>;
  assert.equal(metadata.text, JSON.stringify(payload));
  return { metadata: payload, body: body.text };
}

function assertSafeResult(result: ToolResult, root: string): void {
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(root), false);
  assert.equal(serialized.includes(JSON.stringify(root).slice(1, -1)), false);
  assert.doesNotMatch(serialized, /stack/u);
}

test("two servers share complete dependencies while exposing distinct fourteen-tool surfaces", async t => {
  const f = await fixture(t);
  const baseline = (await f.standard.client.listTools()).tools;
  const enabled = (await f.compatibility.client.listTools()).tools;
  assert.deepEqual(baseline.map(tool => tool.name).sort(), [
    "obsidian_help", "reference_query", "search_query", "tag_list", "vault_append", "vault_delete",
    "vault_get_document_map", "vault_list", "vault_move", "vault_patch", "vault_read", "vault_read_binary",
    "vault_replace_text", "vault_write",
  ]);
  assert.equal(enabled.length, 14);
  assert.equal(new Set(baseline.map(tool => tool.name)).size, 14);
  assert.equal(new Set(enabled.map(tool => tool.name)).size, 14);
  const shared = baseline.filter(tool => !structuredNames.has(tool.name));
  assert.equal(shared.length, 10);
  const expectedShared = shared.map(tool => {
    const { outputSchema: _outputSchema, ...textTool } = tool;
    assert.ok(_outputSchema);
    if (tool.name !== "vault_replace_text") return textTool;
    assert.ok(typeof textTool.description === "string");
    assert.match(textTool.description, /\bvault_read\b/u);
    return { ...textTool, description: textTool.description.replace(/\bvault_read\b/gu, "vault_read_text") };
  });
  assert.deepEqual(enabled.filter(tool => !textNames.has(tool.name)), expectedShared);
  assert.deepEqual(enabled.filter(tool => textNames.has(tool.name)).map(tool => tool.name).sort(),
    [...textNames].sort());
  for (const tool of enabled) assert.equal(Object.hasOwn(tool, "outputSchema"), false, tool.name);
  for (const tool of baseline) assert.ok(tool.outputSchema, tool.name);
  for (const [canonicalName, textName] of textTools) {
    const canonical = baseline.find(tool => tool.name === canonicalName);
    const text = enabled.find(tool => tool.name === textName);
    assert.ok(canonical && text);
    assert.deepEqual(text.inputSchema, canonical.inputSchema);
    assert.deepEqual(text.annotations, canonical.annotations);
    assert.equal(Object.hasOwn(text, "outputSchema"), false);
    assert.equal(baseline.some(tool => tool.name === textName), false);
    assert.equal(enabled.some(tool => tool.name === canonicalName), false);
    await assert.rejects(f.standard.client.callTool({ name: textName, arguments: {} }),
      new RegExp(`Tool ${textName} not found`, "u"));
    await assert.rejects(f.compatibility.client.callTool({ name: canonicalName, arguments: {} }),
      new RegExp(`Tool ${canonicalName} not found`, "u"));
  }
});

test("legacy text-read opt-in remains compatible and cannot duplicate the text-profile tools", async t => {
  const f = await fixture(t);
  const legacy = await f.openServer({ enableTextRead: true });
  const textLegacy = await f.openServer({ toolProfile: "text", enableTextRead: true });
  const baseline = (await f.standard.client.listTools()).tools;
  const legacyTools = (await legacy.client.listTools()).tools;
  const textToolsWithLegacyFlag = (await textLegacy.client.listTools()).tools;
  assert.equal(legacyTools.length, 15);
  assert.equal(new Set(legacyTools.map(tool => tool.name)).size, 15);
  assert.deepEqual(legacyTools.filter(tool => tool.name !== "vault_read_text"), baseline);
  assert.deepEqual(legacyTools.filter(tool => textNames.has(tool.name)).map(tool => tool.name), ["vault_read_text"]);
  assert.equal(textToolsWithLegacyFlag.length, 14);
  assert.equal(new Set(textToolsWithLegacyFlag.map(tool => tool.name)).size, 14);
  assert.deepEqual(textToolsWithLegacyFlag, (await f.compatibility.client.listTools()).tools);
});

test("whole-file text reads separate every metadata field from the unmodified body, including empty files", async t => {
  const f = await fixture(t);
  for (const [name, body] of [
    [notePath, source],
    ["空文件.md", ""],
    ["仅空白.md", " \r\n\r\n\t"],
    ["原文.md", '\uFEFF# 原样 🌫️\r\n她说："你好"。\r\n字面 \\u4e2d、\\n、\\r\\n 和 \\\\。\r\n\r\n'],
    ["无末尾换行.md", '首行\n"quoted"\n末行 🌱'],
  ] as const) {
    await writeFile(path.join(f.vault, name), body, "utf8");
    const standard = await f.standard.client.callTool({ name: "vault_read", arguments: { path: name } });
    const text = await f.compatibility.client.callTool({ name: "vault_read_text", arguments: { path: name } });
    assert.notEqual(standard.isError, true, JSON.stringify(standard));
    assert.deepEqual(standard.content, []);
    const { content, ...metadata } = standard.structuredContent as Record<string, unknown>;
    assert.equal(content, body);
    const actual = rawTextPayload(text);
    const expectedMetadata: Record<string, unknown> = { ...metadata, textField: "content" };
    assert.deepEqual(actual.metadata, expectedMetadata);
    assert.equal(Object.hasOwn(actual.metadata, "content"), false);
    assert.equal(actual.body, body);
    assert.equal(actual.metadata["version"], computeContentVersion(Buffer.from(body, "utf8")));
    assert.deepEqual(Object.keys(actual.metadata).sort(), ["frontmatter", "path", "stat", "tags", "textField", "version"]);
    assert.equal((actual.metadata["stat"] as { size: number }).size, Buffer.byteLength(body, "utf8"));
  }
});

test("heading and block text reads split textual targets while every frontmatter type remains JSON", async t => {
  const f = await fixture(t);
  for (const args of [
    { path: notePath, targetType: "heading", target: [heading] },
    { path: notePath, targetType: "heading", target: [heading, literalHeading], scope: "markerAndContent" },
    { path: notePath, targetType: "block", target: "first-id" },
    { path: notePath, targetType: "block", target: "first-id", scope: "markerAndContent" },
  ] as const) {
    const standard = await f.standard.client.callTool({ name: "vault_read", arguments: args });
    const text = await f.compatibility.client.callTool({ name: "vault_read_text", arguments: args });
    assert.notEqual(standard.isError, true, JSON.stringify(standard));
    const expected = standard.structuredContent as { path: string; version: string; result: string };
    assert.equal(typeof expected.result, "string");
    assert.deepEqual(rawTextPayload(text), {
      metadata: { path: expected.path, version: expected.version, textField: "result" }, body: expected.result,
    });
  }
  const typedPath = "属性.md";
  const typedSource = '---\r\n文字: \'字面 \\n 和 "引号" 🌱\'\r\n数字: 7\r\n数组: [一, 2, false]\r\n对象: {状态: 就绪, active: false}\r\n布尔: false\r\n空值: null\r\n---\r\n';
  await writeFile(path.join(f.vault, typedPath), typedSource, "utf8");
  for (const [field, expected] of [
    ["文字", '字面 \\n 和 "引号" 🌱'], ["数字", 7], ["数组", ["一", 2, false]],
    ["对象", { 状态: "就绪", active: false }], ["布尔", false], ["空值", null],
  ] as const) {
    const args = { path: typedPath, targetType: "frontmatter", target: field };
    const standard = await f.standard.client.callTool({ name: "vault_read", arguments: args });
    const text = await f.compatibility.client.callTool({ name: "vault_read_text", arguments: args });
    assert.notEqual(text.isError, true, JSON.stringify(text));
    const actual = textPayload(text);
    assert.deepEqual(actual, standard.structuredContent);
    assert.deepEqual(actual, { path: typedPath, version: computeContentVersion(Buffer.from(typedSource, "utf8")), result: expected });
  }
});

test("the legacy text-read flag retains its single JSON block for full and targeted reads", async t => {
  const f = await fixture(t);
  const legacy = await f.openServer({ enableTextRead: true });
  for (const args of [
    { path: notePath },
    { path: notePath, targetType: "heading", target: [heading] },
    { path: notePath, targetType: "block", target: "first-id" },
    { path: notePath, targetType: "frontmatter", target: "标题" },
  ] as const) {
    const standard = await f.standard.client.callTool({ name: "vault_read", arguments: args });
    const legacyRead = await legacy.client.callTool({ name: "vault_read_text", arguments: args });
    assert.notEqual(legacyRead.isError, true, JSON.stringify(legacyRead));
    assert.deepEqual(textPayload(legacyRead), standard.structuredContent);
  }
  const standardHelp = await f.standard.client.callTool({ name: "obsidian_help", arguments: {} });
  const legacyHelp = await legacy.client.callTool({ name: "obsidian_help", arguments: {} });
  assert.deepEqual(legacyHelp, standardHelp);
});

test("the raw body and metadata version can be used directly for exact replacement with ifMatch", async t => {
  const f = await fixture(t);
  const before = rawTextPayload(await f.compatibility.client.callTool({ name: "vault_read_text", arguments: { path: notePath } }));
  assert.equal(before.body, source);
  const newBody = source.replace("第一处 🌱", '她说："原样" 🌱，字面 \\n');
  const result = await f.compatibility.client.callTool({ name: "vault_replace_text", arguments: {
    path: notePath, oldText: before.body, newText: newBody, ifMatch: before.metadata["version"],
  } });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const receipt = textPayload(result) as { version: string; replacementCount: number };
  const actual = await readFile(path.join(f.vault, notePath));
  assert.equal(actual.toString("utf8"), newBody);
  assert.equal(receipt.version, computeContentVersion(actual));
  assert.equal(receipt.replacementCount, 1);
  const after = rawTextPayload(await f.compatibility.client.callTool({ name: "vault_read_text", arguments: { path: notePath } }));
  assert.equal(after.body, newBody);
  assert.equal(after.metadata["version"], receipt.version);
  const stale = await f.compatibility.client.callTool({ name: "vault_replace_text", arguments: {
    path: notePath, oldText: newBody, newText: source, ifMatch: before.metadata["version"],
  } });
  assert.equal(readToolErrorPayload(stale).error.code, "vault_mutation.version_conflict");
  assertSafeResult(stale, f.root);
  assert.equal(await readFile(path.join(f.vault, notePath), "utf8"), newBody);
});

test("tool descriptions direct each profile to its available read and document-map tools", async t => {
  const f = await fixture(t);
  for (const [endpoint, readName, mapName] of [
    [f.standard, "vault_read", "vault_get_document_map"],
    [f.compatibility, "vault_read_text", "vault_get_document_map_text"],
  ] as const) {
    const tools = (await endpoint.client.listTools()).tools;
    const read = tools.find(tool => tool.name === readName);
    const replace = tools.find(tool => tool.name === "vault_replace_text");
    assert.ok(read && replace);
    assert.match(read.description ?? "", new RegExp(`\\b${mapName}\\b`, "u"));
    assert.match(replace.description ?? "", new RegExp(`\\b${readName}\\b`, "u"));
    const unavailableMap = mapName === "vault_get_document_map" ? "vault_get_document_map_text" : "vault_get_document_map";
    const unavailableRead = readName === "vault_read" ? "vault_read_text" : "vault_read";
    assert.doesNotMatch(read.description ?? "", new RegExp(`\\b${unavailableMap}\\b`, "u"));
    assert.doesNotMatch(replace.description ?? "", new RegExp(`\\b${unavailableRead}\\b`, "u"));
  }
});

test("text-profile help refers to the four available text tools while keeping stable error codes", async t => {
  const f = await fixture(t);
  const textSections: string[] = [];
  for (const [topic, referencedTools] of [
    ["read", ["vault_list", "vault_read", "vault_get_document_map"]],
    ["write", ["vault_read", "vault_get_document_map"]],
    ["search", ["search_query", "vault_read", "vault_get_document_map"]],
  ] as const) {
    const standard = await f.standard.client.callTool({ name: "obsidian_help", arguments: { topic } });
    const text = await f.compatibility.client.callTool({ name: "obsidian_help", arguments: { topic } });
    assert.notEqual(standard.isError, true);
    assert.notEqual(text.isError, true);
    const standardHelp = (standard.structuredContent as { text: string }).text;
    assert.deepEqual(standard.content, []);
    const textHelp = (textPayload(text) as { text: string }).text;
    textSections.push(textHelp);
    for (const name of referencedTools) {
      assert.match(standardHelp, new RegExp(`\\b${name}\\b(?!\\.)`, "u"));
      assert.match(textHelp, new RegExp(`\\b${name}_text\\b`, "u"));
    }
    for (const name of structuredNames) {
      // Error codes such as search_query.budget_exceeded keep their original namespace.
      assert.doesNotMatch(textHelp, new RegExp(`\\b${name}\\b(?!\\.)`, "u"));
    }
    if (topic === "search") {
      assert.match(standardHelp, /\bsearch_query\.budget_exceeded\b/u);
      assert.match(textHelp, /\bsearch_query\.budget_exceeded\b/u);
      assert.doesNotMatch(textHelp, /\bsearch_query_text\.budget_exceeded\b/u);
    }
  }
  for (const name of textNames) assert.match(textSections.join("\n"), new RegExp(`\\b${name}\\b`, "u"));
});

test("missing-heading errors keep their codes and direct recovery to each profile's document-map tool", async t => {
  const f = await fixture(t);
  for (const [standardName, textName, args] of [
    ["vault_read", "vault_read_text", { path: notePath, targetType: "heading", target: ["不存在"] }],
    ["vault_patch", "vault_patch", { path: notePath, targetType: "heading", target: ["不存在"],
      operation: "replace", content: "替换内容", ifMatch: computeContentVersion(Buffer.from(source, "utf8")) }],
  ] as const) {
    const standard = await f.standard.client.callTool({ name: standardName, arguments: args });
    const text = await f.compatibility.client.callTool({ name: textName, arguments: args });
    const original = readToolErrorPayload(standard);
    const adjusted = readToolErrorPayload(text);
    assert.equal(original.error.code, "vault_semantic.TargetNotFoundError");
    assert.match(original.error.message, /\bvault_get_document_map\b/u);
    assert.doesNotMatch(original.error.message, /\bvault_get_document_map_text\b/u);
    assert.deepEqual(adjusted, { error: { ...original.error,
      message: original.error.message.replace(/\bvault_get_document_map\b/gu, "vault_get_document_map_text") } });
    assert.match(adjusted.error.message, /\bvault_get_document_map_text\b/u);
    assert.doesNotMatch(adjusted.error.message, /\bvault_get_document_map\b/u);
  }
  assert.equal(await readFile(path.join(f.vault, notePath), "utf8"), source);
});

test("text list and document map preserve Chinese paths, emoji, literal escapes and usable duplicate heading keys", async t => {
  const f = await fixture(t);
  for (const args of [{}, { path: directory }]) {
    const canonical = await f.standard.client.callTool({ name: "vault_list", arguments: args });
    const text = await f.compatibility.client.callTool({ name: "vault_list_text", arguments: args });
    assert.notEqual(text.isError, true, JSON.stringify(text));
    assert.deepEqual(textPayload(text), canonical.structuredContent);
    const list = textPayload(text) as { files: string[] };
    assert.ok(list.files.includes("path" in args ? path.basename(notePath) : `${directory}/`));
  }
  const canonical = await f.standard.client.callTool({ name: "vault_get_document_map", arguments: { path: notePath } });
  const text = await f.compatibility.client.callTool({ name: "vault_get_document_map_text", arguments: { path: notePath } });
  assert.notEqual(text.isError, true, JSON.stringify(text));
  const map = textPayload(text) as { path: string; version: string; headings: Record<string, Record<string, unknown>>;
    blocks: string[]; frontmatterFields: string[] };
  // In-memory transport retains the core heading tree's null prototype; JSON wire results do not.
  assert.deepEqual(map, JSON.parse(JSON.stringify(canonical.structuredContent)) as unknown);
  assert.equal(map.path, notePath);
  assert.equal(map.version, computeContentVersion(Buffer.from(source, "utf8")));
  assert.deepEqual(map.frontmatterFields, ["标题", "priority", "items", "meta"]);
  assert.deepEqual(map.blocks, ["first-id"]);
  const children = map.headings[heading];
  assert.ok(children);
  const keys = Object.keys(children);
  assert.equal(keys.length, 3);
  assert.equal(keys[0], "重复");
  assert.notEqual(keys[1], keys[0]);
  assert.equal(keys[2], literalHeading);
  const targeted = await f.compatibility.client.callTool({ name: "vault_read_text", arguments: {
    path: notePath, targetType: "heading", target: [heading, keys[1]!],
  } });
  assert.notEqual(targeted.isError, true, JSON.stringify(targeted));
  assert.deepEqual(rawTextPayload(targeted), {
    metadata: { path: notePath, version: map.version, textField: "result" }, body: "第二处 🌫️\r\n",
  });
  const block = text.content[0];
  assert.ok(block?.type === "text" && block.text.includes(heading));
});

test("text search preserves non-boolean JSON values and exact-byte source versions", async t => {
  const f = await fixture(t);
  for (const [field, expected] of [
    ["标题", label], ["priority", 7], ["items", ["一", "二"]], ["meta", { 状态: "就绪", active: false }],
  ] as const) {
    const args = { query: { var: `frontmatter.${field}` }, scope: { directory, recursive: false } };
    const canonical = await f.standard.client.callTool({ name: "search_query", arguments: args });
    const text = await f.compatibility.client.callTool({ name: "search_query_text", arguments: args });
    assert.notEqual(text.isError, true, JSON.stringify(text));
    assert.deepEqual(textPayload(text), canonical.structuredContent);
    assert.deepEqual(textPayload(text), { results: [{ filename: notePath, result: expected,
      version: computeContentVersion(Buffer.from(source, "utf8")) }] });
    if (field === "标题") {
      const block = text.content[0];
      assert.ok(block?.type === "text" && block.text.includes("中文 🌱"));
    }
  }
});

test("text-profile help, tags and references return compact JSON with the standard data contract", async t => {
  const f = await fixture(t);
  const rawReference = `[[${notePath}|中文引用]]`;
  await writeFile(path.join(f.vault, directory, "引用.md"), `# 引用\r\n${rawReference} #中文/子标签\r\n`, "utf8");
  const referenceArgs = { scope: { directory, recursive: false }, target: { path: notePath } };
  for (const [name, args] of [["tag_list", {}], ["reference_query", referenceArgs]] as const) {
    const standard = await f.standard.client.callTool({ name, arguments: args });
    const text = await f.compatibility.client.callTool({ name, arguments: args });
    assert.notEqual(standard.isError, true, JSON.stringify(standard));
    assert.notEqual(text.isError, true, JSON.stringify(text));
    assert.deepEqual(standard.content, []);
    const actual = textPayload(text);
    assert.deepEqual(actual, standard.structuredContent);
    if (name === "tag_list") {
      assert.deepEqual(actual, { tags: [{ name: "中文", count: 1 }, { name: "中文/子标签", count: 1 }] });
    } else {
      const reference = actual as { matches: { raw: string; source: { path: string; version: string } }[] };
      assert.equal(reference.matches[0]?.raw, rawReference);
      assert.equal(reference.matches[0]?.source.path, `${directory}/引用.md`);
    }
  }
  for (const args of [{}, { topic: "binary" }, { topic: "references" }]) {
    const standard = await f.standard.client.callTool({ name: "obsidian_help", arguments: args });
    const text = await f.compatibility.client.callTool({ name: "obsidian_help", arguments: args });
    assert.notEqual(text.isError, true, JSON.stringify(text));
    assert.deepEqual(textPayload(text), standard.structuredContent);
    assert.deepEqual(standard.content, []);
  }
});

test("all six mutation receipts use compact text JSON while standard receipts retain structured content", async t => {
  const standardFixture = await fixture(t);
  const textFixture = await fixture(t);
  const mutationPath = "操作目录/新建 🌱.md";
  const movedPath = "移动目录/移动 🌫️.md";
  const content = "---\r\n状态: 初始\r\n---\r\n# 段落\r\n原文 🌫️\r\n";
  async function execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const standard = await standardFixture.standard.client.callTool({ name, arguments: args });
    const text = await textFixture.compatibility.client.callTool({ name, arguments: args });
    assert.notEqual(standard.isError, true, JSON.stringify(standard));
    assert.notEqual(text.isError, true, JSON.stringify(text));
    assert.deepEqual(standard.content, []);
    const actual = textPayload(text) as Record<string, unknown>;
    assert.deepEqual(actual, standard.structuredContent);
    assert.equal(actual["message"], "OK");
    return actual;
  }
  const created = await execute("vault_write", { path: mutationPath, content });
  assert.equal(created["created"], true);
  const appended = await execute("vault_append", { path: mutationPath, content: "末尾补充 🌱\r\n", ifMatch: created["version"] });
  const patched = await execute("vault_patch", { path: mutationPath, targetType: "frontmatter", target: "状态",
    operation: "replace", value: { 中文: "就绪", list: [false, 7] }, ifMatch: appended["version"] });
  const replaced = await execute("vault_replace_text", { path: mutationPath, oldText: "原文 🌫️", newText: '新文 "🌱"',
    ifMatch: patched["version"] });
  assert.equal(replaced["replacementCount"], 1);
  const moved = await execute("vault_move", { path: mutationPath, destination: movedPath, ifMatch: replaced["version"] });
  assert.deepEqual(moved, { message: "OK", oldPath: mutationPath, newPath: movedPath });
  assert.equal((await readFile(path.join(textFixture.vault, movedPath), "utf8")).includes('新文 "🌱"'), true);
  const deleted = await execute("vault_delete", { path: movedPath, permanent: true, ifMatch: replaced["version"] });
  assert.deepEqual(deleted, { message: "OK", path: movedPath, permanent: true });
  await assert.rejects(readFile(path.join(textFixture.vault, movedPath)), { code: "ENOENT" });
});

test("binary metadata is the first compact JSON block and image, resource and link blocks remain native", async t => {
  const f = await fixture(t);
  const link = { uri: "https://attachments.example.invalid/original?token=fixture", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const overrides = { createBinaryLink: async () => link };
  const standard = await f.openServer({}, overrides);
  const text = await f.openServer({ toolProfile: "text" }, overrides);
  const imagePath = `${directory}/预览 🌱.png`;
  await writeFile(path.join(f.vault, imagePath), await sharp({ create: {
    width: 12, height: 8, channels: 3, background: "#ff8040",
  } }).png().toBuffer());
  for (const [args, nativeType, delivery] of [
    [{ path: imagePath }, "image", "image"],
    [{ path: `${directory}/附件.bin`, as: "bytes" }, "resource", "bytes"],
    [{ path: `${directory}/附件.bin`, as: "link" }, "resource_link", "link"],
    [{ path: `${directory}/附件.bin` }, "resource_link", "link"],
  ] as const) {
    const original = await standard.client.callTool({ name: "vault_read_binary", arguments: args });
    const changed = await text.client.callTool({ name: "vault_read_binary", arguments: args });
    assert.notEqual(original.isError, true, JSON.stringify(original));
    assert.notEqual(changed.isError, true, JSON.stringify(changed));
    assert.equal(Object.hasOwn(changed, "structuredContent"), false);
    assert.equal(changed.content.length, original.content.length + 1);
    assert.equal(changed.content[1]?.type, nativeType);
    assert.deepEqual(changed.content.slice(1), original.content);
    const first = changed.content[0];
    assert.ok(first?.type === "text");
    const metadata = JSON.parse(first.text) as Record<string, unknown>;
    assert.equal(first.text, JSON.stringify(metadata));
    assert.deepEqual(metadata, original.structuredContent);
    assert.equal(metadata["delivery"], delivery);
    const native = changed.content[1];
    if (native?.type === "image") assert.equal(first.text.includes(native.data), false);
    if (native?.type === "resource" && "blob" in native.resource) {
      assert.equal(first.text.includes(native.resource.blob), false);
      const readback = await text.client.readResource({ uri: native.resource.uri });
      assert.deepEqual(readback.contents, [native.resource]);
    }
  }
});

test("text navigation retains strict input validation", async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ["vault_list_text", { path: 7 }],
    ["vault_list_text", { path: directory, maxEntries: 0 }],
    ["vault_list_text", { path: directory, force: true }],
    ["vault_get_document_map_text", {}],
    ["vault_get_document_map_text", { path: notePath, maxBytes: 64 * 1024 * 1024 + 1 }],
    ["vault_get_document_map_text", { path: notePath, maxHeadings: 0 }],
    ["search_query_text", {}],
    ["search_query_text", { query: { var: "path" }, maxResults: 0 }],
    ["search_query_text", { query: { var: "path" }, scope: { directory, recursive: "true" } }],
    ["search_query_text", { query: { var: "path" }, force: true }],
  ] as const) {
    const result = await f.compatibility.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal(Object.hasOwn(result, "structuredContent"), false);
    const block = result.content[0];
    assert.ok(block?.type === "text");
    assert.match(block.text, /Input validation error/u);
    assertSafeResult(result, f.root);
  }
});

test("text navigation preserves real path, budget and business errors", async t => {
  const f = await fixture(t);
  for (const [name, textName, args, code] of [
    ["vault_list", "vault_list_text", { path: "../outside" }, "vault_path.parent_traversal"],
    ["vault_list", "vault_list_text", { path: notePath }, "vault_list.not_directory"],
    ["vault_list", "vault_list_text", { path: "不存在" }, "vault_list.not_found"],
    ["vault_list", "vault_list_text", { path: directory, maxEntries: 1 }, "vault_list.too_many_entries"],
    ["vault_get_document_map", "vault_get_document_map_text", { path: "../outside.md" }, "vault_path.parent_traversal"],
    ["vault_get_document_map", "vault_get_document_map_text", { path: "不存在.md" }, "vault_read.not_found"],
    ["vault_get_document_map", "vault_get_document_map_text", { path: notePath, maxBytes: 1 }, "vault_read.too_large"],
    ["vault_get_document_map", "vault_get_document_map_text", { path: notePath, maxHeadings: 1 }, "vault_document_map.too_many_headings"],
    ["search_query", "search_query_text", { query: { var: "backlinks" } }, "search_query.invalid_query"],
    ["search_query", "search_query_text", { query: { var: "path" }, scope: { directory: "../outside", recursive: true } }, "vault_path.parent_traversal"],
    ["search_query", "search_query_text", { query: { var: "path" }, maxResults: 1 }, "search_query.budget_exceeded"],
  ] as const) {
    const canonical = await f.standard.client.callTool({ name, arguments: args });
    const text = await f.compatibility.client.callTool({ name: textName, arguments: args });
    const error = readToolErrorPayload(text);
    assert.equal(error.error.code, code);
    assert.deepEqual(error, readToolErrorPayload(canonical));
    assertSafeResult(text, f.root);
  }
});

test("text-profile shared-tool errors retain their stable shape without leaking roots or native binary data", async t => {
  const f = await fixture(t);
  for (const [name, args, code] of [
    ["obsidian_help", { topic: "unknown-topic" }, "obsidian_help.unknown_topic"],
    ["reference_query", { scope: { directory, recursive: false }, target: { path: "../outside.md" } }, "vault_path.parent_traversal"],
    ["vault_read_binary", { path: "../outside.bin", as: "bytes" }, "vault_path.parent_traversal"],
    ["vault_write", { path: "../outside.md", content: "文字" }, "vault_path.parent_traversal"],
  ] as const) {
    const standard = await f.standard.client.callTool({ name, arguments: args });
    const text = await f.compatibility.client.callTool({ name, arguments: args });
    const actual = readToolErrorPayload(text);
    assert.equal(actual.error.code, code);
    assert.deepEqual(actual, readToolErrorPayload(standard));
    assertSafeResult(text, f.root);
  }
});

test("text-only presentation still validates dependency outputs before returning data", async t => {
  const f = await fixture(t);
  const secret = `${f.root}/PRIVATE_DEPENDENCY_DATA`;
  const cases = [
    { name: "vault_read_text", args: { path: notePath }, code: "vault_read.internal_error", overrides: {
      readDocument: (async () => ({ path: secret, version: "bad", content: "正文" })) as unknown as VaultMcpServerDependencies["readDocument"],
    } },
    { name: "tag_list", args: {}, code: "tag_list.internal_error", overrides: {
      tagList: (async () => ({ tags: [{ name: secret, count: 0 }] })) as unknown as VaultMcpServerDependencies["tagList"],
    } },
    { name: "reference_query", args: { scope: { directory, recursive: false }, target: { path: notePath } }, code: "reference_query.internal_error", overrides: {
      referenceQuery: (async () => ({ target: { path: secret }, matches: [] })) as unknown as NonNullable<VaultMcpServerDependencies["referenceQuery"]>,
    } },
    { name: "vault_read_binary", args: { path: `${directory}/附件.bin`, as: "bytes" }, code: "vault_read_binary.internal_error", overrides: {
      readBinary: (async () => ({ kind: "bytes", path: secret, version: "bad", mimeType: "application/octet-stream",
        sizeBytes: 3, data: Buffer.from("PRIVATE_BYTES") })) as unknown as NonNullable<VaultMcpServerDependencies["readBinary"]>,
    } },
  ];
  for (const { name, args, code, overrides } of cases) {
    const endpoint = await f.openServer({ toolProfile: "text" }, overrides);
    const result = await endpoint.client.callTool({ name, arguments: args });
    assert.equal(readToolErrorPayload(result).error.code, code);
    assertSafeResult(result, f.root);
    assert.equal(JSON.stringify(result).includes("PRIVATE_DEPENDENCY_DATA"), false);
    assert.equal(JSON.stringify(result).includes(Buffer.from("PRIVATE_BYTES").toString("base64")), false);
  }
});

test("both surfaces share exact versions and serialize competing writes through the same mutation store", async t => {
  const f = await fixture(t);
  const standardRead = await f.standard.client.callTool({ name: "vault_read", arguments: { path: notePath } });
  const compatibilityRead = await f.compatibility.client.callTool({ name: "vault_read_text", arguments: { path: notePath } });
  const before = standardRead.structuredContent as { version: string };
  assert.notEqual(standardRead.isError, true);
  const { content, ...metadata } = standardRead.structuredContent as Record<string, unknown>;
  assert.deepEqual(rawTextPayload(compatibilityRead), { metadata: { ...metadata, textField: "content" }, body: content });
  assert.equal(before.version, computeContentVersion(Buffer.from(source, "utf8")));
  const candidates = ["# 标准入口\r\n标准入口写入 🌱\r\n", "# 文本入口\r\n文本入口写入 🌫️\r\n"];
  const results = await Promise.all([f.standard, f.compatibility].map((endpoint, index) =>
    endpoint.client.callTool({ name: "vault_write", arguments: {
      path: notePath, content: candidates[index]!, ifMatch: before.version,
    } })));
  const winners = results.flatMap((result, index) => result.isError === true ? [] : [index]);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const winner = winners[0]!;
  const successful = results[winner]!;
  const failed = results.find(result => result.isError === true);
  assert.ok(failed);
  const conflict = readToolErrorPayload(failed);
  assert.equal(conflict.error.code, "vault_mutation.version_conflict");
  assert.equal(conflict.error.details?.["expected"], before.version);
  const actual = await readFile(path.join(f.vault, notePath));
  assert.equal(actual.toString("utf8"), candidates[winner]);
  const afterVersion = computeContentVersion(actual);
  assert.equal(conflict.error.details?.["actual"], afterVersion);
  const receipt = (winner === 0 ? successful.structuredContent : textPayload(successful)) as { version: string };
  assert.equal(receipt.version, afterVersion);
  const afterMap = await f.compatibility.client.callTool({ name: "vault_get_document_map_text", arguments: { path: notePath } });
  assert.equal((textPayload(afterMap) as { version: string }).version, afterVersion);
});

test("closing either surface leaves the other surface and its shared dependencies usable", async t => {
  for (const closing of ["standard", "compatibility"] as const) {
    await t.test(closing, async child => {
      const f = await fixture(child);
      const remaining = closing === "standard" ? f.compatibility : f.standard;
      await f[closing].close();
      assert.equal((await remaining.client.listTools()).tools.length, 14);
      const result = await remaining.client.callTool({ name: closing === "standard" ? "vault_read_text" : "vault_read",
        arguments: { path: notePath } });
      assert.notEqual(result.isError, true);
      const read = (closing === "standard" ? rawTextPayload(result).metadata : result.structuredContent) as { version: string };
      const appended = await remaining.client.callTool({ name: "vault_append", arguments: {
        path: notePath, content: "继续写入 🌱\r\n", ifMatch: read.version,
      } });
      assert.notEqual(appended.isError, true, JSON.stringify(appended));
      assert.equal(await readFile(path.join(f.vault, notePath), "utf8"), source + "继续写入 🌱\r\n");
    });
  }
});
