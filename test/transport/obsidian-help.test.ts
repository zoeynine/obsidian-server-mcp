import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  getVaultDocumentMap, listVaultFiles, listVaultTags, readVaultDocument,
  readVaultNote, searchVaultQuery, VaultMutationStore, VaultPathSandbox,
  computeContentVersion, type ReadVaultDocumentOptions,
} from "../../src/core/index.js";
import { HELP_TOPICS } from "../../src/transport/mcp/help-content.generated.js";
import { readObsidianHelp } from "../../src/transport/mcp/obsidian-help.js";
import {
  createVaultMcpServer, OBSIDIAN_HELP_TOOL_NAME,
  type VaultMcpServerDependencies, type VaultMcpServerOptions,
} from "../../src/transport/mcp/server.js";
import { readToolError } from "./tool-error.js";

const guides = ["read", "binary", "search", "references", "tags", "patch", "write", "paths", "files"];
const aliases = [
  ["vault_read", "vault_read_text"],
  ["vault_list", "vault_list_text"],
  ["vault_get_document_map", "vault_get_document_map_text"],
  ["search_query", "search_query_text"],
] as const;
const canonicalTools = [
  "obsidian_help", "reference_query", "search_query", "tag_list", "vault_append", "vault_delete",
  "vault_get_document_map", "vault_list", "vault_move", "vault_patch", "vault_read", "vault_read_binary",
  "vault_replace_text", "vault_write",
];
const profiles: readonly VaultMcpServerOptions[] = [{}, { toolProfile: "text" }, { enableTextRead: true }];
const unavailableNotice = "This tool is documented but is not registered on this endpoint.";
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
interface HelpComposition { readonly binary?: boolean; readonly references?: boolean; readonly mutations?: boolean }

test("help index lists the exact registered tools for dependency compositions and profiles", async t => {
  const full = { binary: true, references: true, mutations: true };
  const cases: { options: VaultMcpServerOptions; composition: HelpComposition; count: number }[] = [
    { options: {}, composition: {}, count: 6 },
    { options: {}, composition: { binary: true }, count: 7 },
    { options: {}, composition: { references: true }, count: 7 },
    { options: {}, composition: { mutations: true }, count: 12 },
    { options: {}, composition: full, count: 14 },
    { options: { toolProfile: "text" }, composition: full, count: 14 },
    { options: { enableTextRead: true }, composition: full, count: 15 },
    { options: { toolProfile: "text", enableTextRead: true }, composition: full, count: 14 },
  ];
  for (const { options, composition, count } of cases) {
    await t.test(`${JSON.stringify(options)} ${JSON.stringify(composition)}`, async child => {
      const client = await createHelpClient(child, options, composition);
      const registered = (await client.listTools()).tools;
      assert.equal(registered.length, count);
      const tool = registered.find(entry => entry.name === OBSIDIAN_HELP_TOOL_NAME)!;
      assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}), ["topic"]);
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.openWorldHint, false);
      const index = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: {} }), options);
      assert.deepEqual(indexTools(index), registered.map(entry => entry.name).sort());
      for (const entry of registered) {
        const manual = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
          arguments: { topic: entry.name } }), options);
        assert.match(manual, /^#{2,3} /u, entry.name);
        const examples = jsonExamples(manual);
        assert.ok(examples.length >= 1 && examples.length <= 3, entry.name);
      }
    });
  }
});

test("all guides and known tool topics remain readable without available endpoints or Vault access", async t => {
  const client = await createHelpClient(t);
  const registered = new Set((await client.listTools()).tools.map(entry => entry.name));
  assert.equal(registered.size, 6);
  for (const topic of [...guides, ...canonicalTools, ...aliases.map(([, alias]) => alias)]) {
    const text = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic } }));
    assert.match(withoutAvailabilityNotice(text), /^#{2,3} /u, topic);
    assert.doesNotMatch(text, /obsidian-help:|# Obsidian Server MCP\n/u, topic);
    if (guides.includes(topic)) {
      assert.equal(text, withoutAvailabilityNotice(text), topic);
      assert.doesNotMatch(text, /```json\n/u, topic);
    }
  }
  for (const topic of ["vault_write", "vault_read_binary", "reference_query", "vault_read_text"]) {
    assert.equal(registered.has(topic), false, topic);
  }
});

test("unregistered tool topics identify their available counterpart without changing the manual", async t => {
  for (const options of profiles) {
    const client = await createHelpClient(t, options);
    const registered = new Set((await client.listTools()).tools.map(entry => entry.name));
    const requests: { topic: string; counterpart?: string }[] = aliases.flatMap(([canonical, alias]) => [
      { topic: canonical, counterpart: alias }, { topic: alias, counterpart: canonical },
    ]);
    requests.push(...["vault_write", "vault_read_binary", "reference_query"].map(topic => ({ topic })));
    for (const { topic, counterpart } of requests) {
      const text = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic } }), options);
      const manual = readObsidianHelp(topic, {
        toolNames: [topic], textProfile: options.toolProfile === "text", legacyTextRead: options.enableTextRead === true,
      }).text;
      if (registered.has(topic)) {
        assert.equal(text, manual, topic);
        assert.match(text, /^## /u, topic);
      } else {
        const counterpartNotice = counterpart !== undefined && registered.has(counterpart)
          ? ` Available counterpart: \`${counterpart}\`.` : "";
        assert.equal(text, unavailableNotice + counterpartNotice + "\n\n" + manual, topic);
      }
    }
  }
});

test("availability hints use the registered names rather than a hypothetical profile counterpart", () => {
  for (const { topic, options } of [
    { topic: "vault_read", options: { toolNames: ["obsidian_help", "vault_list_text"], textProfile: true } },
    { topic: "vault_read_text", options: { toolNames: ["obsidian_help", "vault_list"] } },
  ]) {
    const text = readObsidianHelp(topic, options).text;
    const manual = readObsidianHelp(topic, { ...options, toolNames: [topic] }).text;
    assert.equal(text, unavailableNotice + "\n\n" + manual, topic);
  }
});

test("text aliases reuse one canonical manual and preserve error-code namespaces", async t => {
  const canonicalEntries = HELP_TOPICS.filter(entry => entry.kind === "tool");
  assert.deepEqual(canonicalEntries.map(entry => entry.topic).sort(), [...canonicalTools].sort());
  const aliasNames = new Set<string>(aliases.map(([, alias]) => alias));
  assert.equal(HELP_TOPICS.some(entry => aliasNames.has(entry.topic)), false);
  for (const options of profiles) {
    const client = await createHelpClient(t, options);
    for (const [canonical, alias] of aliases) {
      const source = canonicalEntries.find(entry => entry.topic === canonical)!.text;
      const expected = options.toolProfile === "text" ? textToolNames(source) : source;
      const original = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
        arguments: { topic: canonical } }), options);
      const presented = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
        arguments: { topic: alias } }), options);
      const originalParts = withoutAvailabilityNotice(original).split("\n\n### Presentation\n\n");
      const presentedParts = withoutAvailabilityNotice(presented).split("\n\n### Presentation\n\n");
      assert.equal(originalParts.length, 2, canonical);
      assert.equal(presentedParts.length, 2, alias);
      assert.equal(originalParts[0], expected, canonical);
      assert.equal(presentedParts[0]!.replace(/^## \S+/u, ""), expected.replace(/^## \S+/u, ""), alias);
      assert.match(presentedParts[0]!, new RegExp(`^## ${alias}\\b`, "u"));
      assert.ok(originalParts[1]);
      assert.ok(presentedParts[1]);
      assert.equal(jsonExamples(presented).length, jsonExamples(expected).length, alias);
      assert.doesNotMatch(presented, /(?:vault_read_text|search_query_text|vault_list_text|vault_get_document_map_text)\.[a-z_]+/u);
      if (canonical === "vault_read") {
        assert.match(presentedParts[1]!, /two text blocks/u);
        assert.match(presentedParts[1]!, /textField: "content"/u);
        if (options.enableTextRead) assert.match(presentedParts[1]!, /legacy text-read option/u);
      }
    }
    const read = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
      arguments: { topic: "vault_replace_text" } }), options);
    assert.match(read, options.toolProfile === "text" ? /`vault_read_text`/u : /`vault_read`/u);
    assert.match(read, /vault_mutation\.text_not_found/u);
  }
});

test("unknown topics retain their error shape and recover with the current server index", async t => {
  for (const options of profiles) {
    const client = await createHelpClient(t, options, { binary: true, mutations: true });
    const index = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: {} }), options);
    for (const topic of ["missing", "", "__proto__", "constructor", "../../README.md"]) {
      const result = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: { topic } });
      const error = readToolError(result);
      assert.deepEqual(Object.keys(error), ["code", "message"]);
      assert.equal(error.code, "obsidian_help.unknown_topic");
      assert.equal(error.message, "Unknown topic. " + index);
      assert.doesNotMatch(error.message, /```/u);
    }
    const recovered = helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
      arguments: { topic: "read" } }), options);
    assert.match(recovered, options.toolProfile === "text" ? /vault_read_text/u : /vault_read/u);
  }
});

test("help rejects malformed arguments and extra fields through the SDK", async t => {
  const client = await createHelpClient(t);
  for (const args of [{ topic: 1 }, { topic: ["patch"] }, { path: "private.md" }]) {
    const result = await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME, arguments: args });
    assert.equal(result.isError, true);
  }
});

test("published search examples query content, frontmatter and a scoped compound condition", async t => {
  const { client, vault } = await createExampleClient(t);
  const examples = jsonExamples(helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
    arguments: { topic: "search_query" } })));
  assert.equal(examples.length, 3);
  const notes = {
    "content.md": "# Content\nneedle\n",
    "property.md": "---\nfoo: bar\n---\n# Property\n",
    "outside.md": "---\nfoo: bar\n---\nneedle\n",
    "unrelated.md": "# Unrelated\n",
    "projects/match.md": "---\nfoo: bar\n---\nneedle\n",
    "projects/no-property.md": "# Content\nneedle\n",
    "projects/nested/match.md": "---\nfoo: bar\n---\nneedle\n",
  };
  for (const [name, content] of Object.entries(notes)) {
    await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
    await writeFile(path.join(vault, name), content);
  }
  const expected = [
    ["content.md", "outside.md", "projects/match.md", "projects/nested/match.md", "projects/no-property.md"],
    ["outside.md", "projects/match.md", "projects/nested/match.md", "property.md"],
    ["projects/match.md", "projects/nested/match.md"],
  ];
  for (const [index, example] of examples.entries()) {
    const result = await client.callTool({ name: "search_query", arguments: example });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const matches = (result.structuredContent as { results: { filename: string; result: unknown; version: string }[] }).results;
    assert.deepEqual(matches.map(entry => entry.filename).sort(), expected[index]);
    for (const match of matches) {
      assert.equal(match.result, true);
      assert.equal(match.version, computeContentVersion(notes[match.filename as keyof typeof notes]));
    }
  }
});

test("published patch examples append a sibling, set a property and move a section", async t => {
  const { client, vault } = await createExampleClient(t);
  const examples = jsonExamples(helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
    arguments: { topic: "vault_patch" } })));
  assert.equal(examples.length, 3);
  const source = "# Root\n\n## A\n\nOld body.\n\n## B\n";
  for (const [index, example] of examples.entries()) {
    assert.equal(example["path"], "note.md");
    assert.equal(example["ifMatch"], "<current version>");
    await writeFile(path.join(vault, "note.md"), source);
    const read = await client.callTool({ name: "vault_read", arguments: { path: "note.md" } });
    assert.notEqual(read.isError, true);
    const { version } = read.structuredContent as { version: string };
    const result = await client.callTool({ name: "vault_patch", arguments: { ...example, ifMatch: version } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const output = await readFile(path.join(vault, "note.md"), "utf8");
    const map = await client.callTool({ name: "vault_get_document_map", arguments: { path: "note.md" } });
    assert.notEqual(map.isError, true);
    const headings = (map.structuredContent as { headings: Record<string, unknown> }).headings;
    assert.equal((result.structuredContent as { version: string }).version, computeContentVersion(output));
    if (index === 0) {
      assert.deepEqual(JSON.parse(JSON.stringify(headings)), { Root: { A: {}, Inserted: {}, B: {} } });
      assert.match(output, /## A[\s\S]*Old body\.[\s\S]*## Inserted[\s\S]*## B/u);
    } else if (index === 1) {
      assert.match(output, /^---\nstatus: ready\n---\n/u);
      assert.ok(output.endsWith(source));
      await writeFile(path.join(vault, "note.md"), output.replace("status: ready", "status: draft"));
      const reread = await client.callTool({ name: "vault_read", arguments: { path: "note.md" } });
      const updated = await client.callTool({ name: "vault_patch", arguments: { ...example,
        ifMatch: (reread.structuredContent as { version: string }).version } });
      assert.notEqual(updated.isError, true, JSON.stringify(updated));
      assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), output);
    } else {
      assert.deepEqual(JSON.parse(JSON.stringify(headings)), { Root: { B: { A: {} } } });
      assert.match(output, /## B[\s\S]*### A[\s\S]*Old body\./u);
    }
  }
});

test("published exact replacement example uses a whole-file read and literal replacement text", async t => {
  const { client, vault } = await createExampleClient(t);
  const examples = jsonExamples(helpText(await client.callTool({ name: OBSIDIAN_HELP_TOOL_NAME,
    arguments: { topic: "vault_replace_text" } })));
  assert.equal(examples.length, 1);
  const example = examples[0]!;
  assert.deepEqual(Object.keys(example), ["path", "oldText", "newText", "ifMatch"]);
  assert.equal(example["path"], "note.md");
  assert.equal(example["ifMatch"], "<current version>");
  const source = "# Root\n\n## A\nOld body.\n\n## B\nKeep me.\n";
  await writeFile(path.join(vault, "note.md"), source);
  const read = await client.callTool({ name: "vault_read", arguments: { path: "note.md" } });
  assert.notEqual(read.isError, true);
  const whole = read.structuredContent as { content: string; version: string };
  assert.equal(whole.content, source);
  const oldText = example["oldText"] as string;
  const start = whole.content.indexOf(oldText);
  assert.ok(start >= 0);
  assert.equal(whole.content.slice(start, start + oldText.length), oldText);
  assert.equal(whole.content.indexOf(oldText, start + 1), -1);
  const replaced = await client.callTool({ name: "vault_replace_text", arguments: { ...example, ifMatch: whole.version } });
  assert.notEqual(replaced.isError, true, JSON.stringify(replaced));
  const expected = "# Root\n\n## A\nNew body. $& is literal.\n\n## B\nKeep me.\n";
  assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), expected);
  const receipt = replaced.structuredContent as Record<string, unknown>;
  assert.equal(receipt["beforeSizeBytes"], Buffer.byteLength(source));
  assert.equal(receipt["sizeBytes"], Buffer.byteLength(expected));
  assert.equal(receipt["version"], computeContentVersion(expected));
  assert.equal(receipt["created"], false);
  assert.equal(receipt["replacementCount"], 1);
});

function helpText(result: ToolResult, options: VaultMcpServerOptions = {}): string {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  let payload: unknown;
  if (options.toolProfile === "text") {
    assert.equal(Object.hasOwn(result, "structuredContent"), false);
    assert.equal(result.content.length, 1);
    const block = result.content[0];
    assert.ok(block?.type === "text");
    payload = JSON.parse(block.text) as unknown;
    assert.equal(block.text, JSON.stringify(payload));
  } else {
    assert.deepEqual(result.content, []);
    payload = result.structuredContent;
  }
  assert.ok(payload !== null && typeof payload === "object");
  assert.deepEqual(Object.keys(payload), ["text"]);
  const text = (payload as { text: unknown }).text;
  assert.equal(typeof text, "string");
  return text as string;
}

function indexTools(text: string): string[] {
  assert.ok(text.length < 1600);
  assert.doesNotMatch(text, /```/u);
  const [guideSection, toolSection, extra] = text.split("\nTools:\n");
  assert.equal(extra, undefined);
  assert.ok(guideSection);
  assert.ok(guideSection.startsWith("Help topics (pass topic):\nGuides:\n"));
  assert.deepEqual(guideSection.split("\n").slice(2).map(line => line.split(":")[0]), guides);
  assert.ok(toolSection);
  const names = toolSection.split("\n");
  assert.ok(names.every(name => /^[a-z_]+$/u.test(name)));
  assert.equal(new Set(names).size, names.length);
  return names;
}

function jsonExamples(text: string): Record<string, unknown>[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/gu)]
    .map(match => JSON.parse(match[1]!) as Record<string, unknown>);
}

function withoutAvailabilityNotice(text: string): string {
  return text.replace(/^This tool is documented but is not registered on this endpoint\.(?: Available counterpart: `[a-z_]+`\.)?\n\n/u, "");
}

function textToolNames(text: string): string {
  for (const [canonical, alias] of aliases) text = text.replace(new RegExp(`\\b${canonical}\\b(?!\\.)`, "gu"), alias);
  return text;
}

async function createHelpClient(t: TestContext, options: VaultMcpServerOptions = {},
  composition: HelpComposition = {}): Promise<Client> {
  let vaultCalls = 0;
  const unexpected = async (): Promise<never> => {
    vaultCalls++;
    throw new Error("Help must not call a Vault use case");
  };
  const dependencies: VaultMcpServerDependencies = {
    getDocumentMap: unexpected, listEntries: unexpected, readDocument: unexpected,
    searchQuery: unexpected, tagList: unexpected,
    ...(composition.binary ? { readBinary: unexpected } : {}),
    ...(composition.references ? { referenceQuery: unexpected } : {}),
    ...(composition.mutations ? { mutations: {
      write: unexpected, append: unexpected, patch: unexpected, replaceText: unexpected,
      move: unexpected, delete: unexpected,
    } as unknown as VaultMutationStore } : {}),
  };
  const client = await openClient(t, dependencies, options);
  t.after(() => { assert.equal(vaultCalls, 0); });
  return client;
}

async function createExampleClient(t: TestContext): Promise<{ client: Client; vault: string }> {
  const workspace = path.resolve(".test-dist");
  await mkdir(workspace, { recursive: true });
  const vault = await mkdtemp(path.join(workspace, "obsidian-help-examples-"));
  t.after(async () => {
    const relative = path.relative(workspace, vault);
    assert.ok(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(vault, { recursive: true, force: true });
  });
  const sandbox = await VaultPathSandbox.create(vault);
  const reader = (input: string, options?: ReadVaultDocumentOptions) => readVaultDocument(sandbox, input, options);
  const client = await openClient(t, {
    getDocumentMap: (input, options) => getVaultDocumentMap(reader, input, options),
    listEntries: (input, options) => listVaultFiles(sandbox, input, options),
    readDocument: (input, options) => readVaultNote(reader, input, options),
    searchQuery: (query, options) => searchVaultQuery(sandbox, reader, query, options),
    tagList: options => listVaultTags(sandbox, reader, options),
    mutations: await VaultMutationStore.create(sandbox),
  });
  return { client, vault };
}

async function openClient(t: TestContext, dependencies: VaultMcpServerDependencies,
  options: VaultMcpServerOptions = {}): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createVaultMcpServer(dependencies, options), { transport: serverTransport });
  const client = new Client({ name: "help-test", version: "1.0.0" });
  t.after(async () => { try { await client.close(); } finally { await handle.close(); } });
  await client.connect(clientTransport);
  return client;
}
