import { readVaultNote } from "../../src/core/document/read-vault-note.js";
import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  MAX_VAULT_DOCUMENT_BYTES,
  VaultPathSandbox,
  computeContentVersion,
  getVaultDocumentMap,
  listVaultFiles,
  listVaultTags,
  readVaultDocument,
  searchVaultQuery,
  VaultMutationStore,
  type MutationIO,
  nativeMutationIO,
} from "../../src/core/index.js";
import {
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  OBSIDIAN_HELP_TOOL_NAME,
  SEARCH_QUERY_TOOL_NAME,
  TAG_LIST_TOOL_NAME,
  VAULT_GET_DOCUMENT_MAP_TOOL_NAME,
  VAULT_LIST_TOOL_NAME,
  VAULT_READ_TOOL_NAME,
  VAULT_WRITE_TOOL_NAME,
  VAULT_APPEND_TOOL_NAME,
  VAULT_PATCH_TOOL_NAME,
  VAULT_MOVE_TOOL_NAME,
  VAULT_DELETE_TOOL_NAME,
  type SearchQueryUseCase,
  type TagListUseCase,
  type VaultDocumentMapUseCase,
  type VaultReadUseCase,
} from "../../src/transport/mcp/server.js";
import { serveVaultMcpStdio } from "../../src/transport/mcp/stdio.js";

test("a read-only composition exposes five Vault read tools plus static help", async (t) => {
  const harness = await createHarness(t);

  assert.deepEqual(harness.client.getServerVersion(), {
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  assert.equal(harness.client.getDiscoverResult(), undefined);
  assert.equal(harness.client.getServerCapabilities()?.tools !== undefined, true);

  const listed = await harness.client.listTools();

  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      OBSIDIAN_HELP_TOOL_NAME,
      SEARCH_QUERY_TOOL_NAME,
      TAG_LIST_TOOL_NAME,
      VAULT_GET_DOCUMENT_MAP_TOOL_NAME,
      VAULT_LIST_TOOL_NAME,
      VAULT_READ_TOOL_NAME,
    ],
  );
  for (const tool of listed.tools) {
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
  }
  const searchQueryTool = listed.tools.find(
    (tool) => tool.name === SEARCH_QUERY_TOOL_NAME,
  );
  assert.equal(searchQueryTool?.inputSchema.properties?.["maxTagsPerFile"], undefined);
});

test("tools/call vault_read returns content and exact-byte version", async (t) => {
  const harness = await createHarness(t);
  const bytes = Buffer.from("# MCP\r\n\r\n纵向切片\n", "utf8");
  await writeFile(path.join(harness.vault, "note.md"), bytes);

  const result = await harness.client.callTool({
    arguments: { path: "note.md" },
    name: VAULT_READ_TOOL_NAME,
  });

  assert.notEqual(result.isError, true);
  const output = result.structuredContent as {content: string; version: string; stat: {size: number}};
  assert.equal(output.content, bytes.toString("utf8"));
  assert.equal(output.version, computeContentVersion(bytes));
  assert.equal(output.stat.size, bytes.byteLength);
  assert.deepEqual(result.content, []);
});

test("read and document-map tools advertise and accept the shared inclusive byte cap", async (t) => {
  const harness = await createHarness(t);
  await writeFile(path.join(harness.vault, "note.md"), "# Heading\nbody\n");
  await writeFile(path.join(harness.vault, "empty.md"), "");
  const listed = await harness.client.listTools();

  for (const name of [VAULT_READ_TOOL_NAME, VAULT_GET_DOCUMENT_MAP_TOOL_NAME]) {
    const tool = listed.tools.find((entry) => entry.name === name);
    const limit = tool?.inputSchema.properties?.["maxBytes"];
    assert.ok(typeof limit === "object" && limit !== null && "maximum" in limit);
    assert.equal(limit["maximum"], 64 * 1024 * 1024);

    const atCap = await harness.client.callTool({
      arguments: { path: "note.md", maxBytes: MAX_VAULT_DOCUMENT_BYTES },
      name,
    });
    assert.notEqual(atCap.isError, true);
    const atZero = await harness.client.callTool({
      arguments: { path: "empty.md", maxBytes: 0 },
      name,
    });
    assert.notEqual(atZero.isError, true);
  }
});

test("read and document-map schemas reject oversized budgets before calling core", async (t) => {
  let coreCalls = 0;
  const unexpectedCall = async (): Promise<never> => {
    coreCalls += 1;
    throw new Error("An invalid MCP budget must not reach core");
  };
  const harness = await createHarness(t, {
    getDocumentMap: unexpectedCall,
    readDocument: unexpectedCall,
  });

  for (const name of [VAULT_READ_TOOL_NAME, VAULT_GET_DOCUMENT_MAP_TOOL_NAME]) {
    for (const maxBytes of [MAX_VAULT_DOCUMENT_BYTES + 1, Number.MAX_SAFE_INTEGER]) {
      const result = await harness.client.callTool({
        arguments: { path: "note.md", maxBytes },
        name,
      });
      const message = readTextBlock(result.content);
      assert.equal(result.isError, true);
      assert.match(message, /Input validation error/u);
      assert.equal(message.includes(harness.vault), false);
      assert.equal(message.includes("stack"), false);
    }
  }
  assert.equal(coreCalls, 0);
});

test("core path failures become stable MCP tool errors", async (t) => {
  const harness = await createHarness(t);

  const result = await harness.client.callTool({
    arguments: { path: "../outside.md" },
    name: VAULT_READ_TOOL_NAME,
  });

  assert.equal(result.isError, true);
  assert.deepEqual(readTextPayload(result.content), {
    error: {
      code: "vault_path.parent_traversal",
      details: {
        path: "../outside.md",
        reason: "parent_traversal",
      },
      message: "Vault path must not contain parent traversal segments",
    },
  });
});

test("read, list and document-map permission failures are classified without leaking OS details", async (t) => {
  const harness = await createHarness(t);
  let osCode = "EACCES";
  t.mock.method(harness.sandbox, "resolve", async () => {
    throw Object.assign(new Error(`${osCode}: ${harness.vault}/private.md`), {
      code: osCode,
      path: path.join(harness.vault, "private.md"),
    });
  });

  for (osCode of ["EACCES", "EPERM", "EIO"]) {
    for (const [name, prefix] of [
      [VAULT_READ_TOOL_NAME, "vault_read"],
      [VAULT_LIST_TOOL_NAME, "vault_list"],
      [VAULT_GET_DOCUMENT_MAP_TOOL_NAME, osCode === "EIO" ? "vault_document_map" : "vault_read"],
    ] as const) {
      const result = await harness.client.callTool({ name, arguments: { path: "private.md" } });
      assert.equal(result.isError, true);
      const payload = readTextPayload(result.content) as { error: { code: string } };
      assert.equal(payload.error.code, `${prefix}.${osCode === "EIO" ? "internal_error" : "permission_denied"}`);
      assert.deepEqual(result.structuredContent, payload);
      assertDoesNotLeakRootOrStack(result, harness.vault);
      assert.equal(JSON.stringify(result).includes(osCode), false);
    }
  }
});

test("tools/call vault_list returns sorted root and nested entry metadata", async (t) => {
  const harness = await createHarness(t);
  await writeFile(path.join(harness.vault, "z-last.md"), "z");
  await mkdir(path.join(harness.vault, "folder"));
  await writeFile(path.join(harness.vault, "A-first.md"), "a");

  const rootResult = await harness.client.callTool({
    arguments: {},
    name: VAULT_LIST_TOOL_NAME,
  });
  const nestedResult = await harness.client.callTool({
    arguments: { path: "folder" },
    name: VAULT_LIST_TOOL_NAME,
  });

  assert.notEqual(rootResult.isError, true);
  assert.deepEqual(rootResult.structuredContent, {files: ["A-first.md", "folder/", "z-last.md"]});
  assert.deepEqual(rootResult.content, []);
  assert.deepEqual(nestedResult.structuredContent, {files: []});
});

test("core list failures become stable MCP tool errors", async (t) => {
  const harness = await createHarness(t);
  await writeFile(path.join(harness.vault, "note.md"), "note");

  const result = await harness.client.callTool({
    arguments: { path: "note.md" },
    name: VAULT_LIST_TOOL_NAME,
  });

  assert.equal(result.isError, true);
  assert.deepEqual(readTextPayload(result.content), {
    error: {
      code: "vault_list.not_directory",
      details: { path: "note.md" },
      message: "Vault list target is not a directory: note.md",
    },
  });
});

test("vault_list maps a real file-as-parent path to a stable not-found error", async (t) => {
  const harness = await createHarness(t);
  await writeFile(path.join(harness.vault, "note.md"), "note");
  const result = await harness.client.callTool({
    arguments: { path: "note.md/nested" },
    name: VAULT_LIST_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_list.not_found",
      details: { path: "note.md/nested" },
      message: "Vault directory does not exist: note.md/nested",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("vault_list maps injected POSIX ENOTDIR without leaking filesystem details", async (t) => {
  const harness = await createHarness(t);
  t.mock.method(harness.sandbox, "resolve", async () => {
    throw Object.assign(new Error(`ENOTDIR: ${harness.vault}/note.md/nested`), {
      code: "ENOTDIR",
    });
  });
  const result = await harness.client.callTool({
    arguments: { path: "note.md/nested" },
    name: VAULT_LIST_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_list.not_found",
      details: { path: "note.md/nested" },
      message: "Vault directory does not exist: note.md/nested",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("tools/call vault_get_document_map returns a version-pinned heading map", async (t) => {
  const harness = await createHarness(t);
  const source = "# 总览\r\n正文\r\n## 细节\r\n";
  const bytes = Buffer.from(source, "utf8");
  await writeFile(path.join(harness.vault, "map.md"), bytes);

  const result = await harness.client.callTool({
    arguments: { path: "map.md" },
    name: VAULT_GET_DOCUMENT_MAP_TOOL_NAME,
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent)), {path: "map.md", version: computeContentVersion(bytes), headings: {总览: {细节: {}}}, blocks: [], frontmatterFields: []});
  assert.deepEqual(result.content, []);
});

test("document-map path failures remain stable MCP tool errors", async (t) => {
  const harness = await createHarness(t);

  const result = await harness.client.callTool({
    arguments: { path: "../outside.md" },
    name: VAULT_GET_DOCUMENT_MAP_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_path.parent_traversal",
      details: {
        path: "../outside.md",
        reason: "parent_traversal",
      },
      message: "Vault path must not contain parent traversal segments",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("document-map read failures retain the safe read error contract", async (t) => {
  const harness = await createHarness(t);
  await writeFile(
    path.join(harness.vault, "invalid.md"),
    Buffer.from([0x23, 0x20, 0x61, 0xc3, 0x28]),
  );

  const result = await harness.client.callTool({
    arguments: { path: "invalid.md" },
    name: VAULT_GET_DOCUMENT_MAP_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_read.invalid_utf8",
      details: { encoding: "utf-8", path: "invalid.md" },
      message: "Vault document is not valid UTF-8: invalid.md",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("document-map parser bounds become stable MCP tool errors", async (t) => {
  const harness = await createHarness(t);
  await writeFile(path.join(harness.vault, "large-map.md"), "# A\n# B\n");

  const result = await harness.client.callTool({
    arguments: { maxHeadings: 1, path: "large-map.md" },
    name: VAULT_GET_DOCUMENT_MAP_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_document_map.too_many_headings",
      details: {
        maxHeadings: 1,
        observedAtLeast: 2,
        path: "large-map.md",
      },
      message: "Markdown document exceeds the 1-heading map limit",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("tools/call search_query returns versioned boolean results in structuredContent only", async (t) => {
  const harness = await createHarness(t);
  const bytes = Buffer.from("\ufeffneedle\r\n#direct", "utf8");
  await writeFile(path.join(harness.vault, "query.md"), bytes);
  await writeFile(path.join(harness.vault, "other.md"), "other");

  const result = await harness.client.callTool({
    arguments: {
      query: {
        and: [
          { in: ["needle", { var: "content" }] },
          { in: ["direct", { var: "tags" }] },
        ],
      },
    },
    name: SEARCH_QUERY_TOOL_NAME,
  });

  assert.notEqual(result.isError, true);
  const expected = [
    {
      filename: "query.md",
      result: true,
      version: computeContentVersion(bytes),
    },
  ];
  assert.deepEqual(result.structuredContent, { results: expected });
  assert.deepEqual(result.content, []);
});

test("search_query transport errors are stable and do not disclose roots or stacks", async (t) => {
  const harness = await createHarness(t);

  const invalid = await harness.client.callTool({
    arguments: { query: { var: "backlinks" } },
    name: SEARCH_QUERY_TOOL_NAME,
  });
  const invalidPayload = readTextPayload(invalid.content);
  assert.equal(invalid.isError, true);
  assert.deepEqual(invalidPayload, {
    error: {
      code: "search_query.invalid_query",
      details: { reason: "invalid_var" },
      message: "search_query query is invalid: invalid_var",
    },
  });
  assertDoesNotLeakRootOrStack(invalidPayload, harness.vault);

  await writeFile(path.join(harness.vault, "note.md"), "xx");
  await writeFile(path.join(harness.vault, "second.md"), "yy");
  const budget = await harness.client.callTool({
    arguments: {
      maxResults: 1,
      query: { "!=": [{ var: "path" }, "never"] },
    },
    name: SEARCH_QUERY_TOOL_NAME,
  });
  const budgetPayload = readTextPayload(budget.content);
  assert.equal(budget.isError, true);
  assert.deepEqual(budgetPayload, {
    error: {
      code: "search_query.budget_exceeded",
      details: {
        budget: "maxResults",
        limit: 1,
        observedAtLeast: "2",
      },
      message: "search_query exceeded its maxResults budget of 1",
    },
  });
  assertDoesNotLeakRootOrStack(budgetPayload, harness.vault);
});

test("search_query reports aggregate and per-note output overflow as a result budget", async (t) => {
  const harness = await createHarness(t);
  const source = "x".repeat(1024 * 1024);
  await writeFile(path.join(harness.vault, "a.md"), source);
  await writeFile(path.join(harness.vault, "b.md"), source);

  // Two 2 MiB results exceed the aggregate cap; one 5 MiB result exceeds the worker cap.
  for (const copies of [2, 5]) {
    const result = await harness.client.callTool({
      name: SEARCH_QUERY_TOOL_NAME,
      arguments: { query: { cat: Array.from({ length: copies }, () => ({ var: "content" })) } },
    });
    assert.equal(result.isError, true);
    const payload = readTextPayload(result.content) as {
      error: { code: string; details: { budget: string; limit: number; observedAtLeast: string } };
    };
    assert.equal(payload.error.code, "search_query.budget_exceeded");
    assert.equal(payload.error.details.budget, "maxOutputBytes");
    assert.equal(payload.error.details.limit, 4 * 1024 * 1024);
    assert.ok(BigInt(payload.error.details.observedAtLeast) > BigInt(payload.error.details.limit));
    assert.deepEqual(result.structuredContent, payload);
    assertDoesNotLeakRootOrStack(result, harness.vault);
    assert.equal("results" in (result.structuredContent ?? {}), false);
  }
});

test("search_query read failures reuse the stable safe-read MCP error contract", async (t) => {
  const harness = await createHarness(t);
  await writeFile(
    path.join(harness.vault, "invalid.md"),
    Buffer.from([0xc3, 0x28]),
  );

  const result = await harness.client.callTool({
    arguments: { query: { "!=": [{ var: "path" }, "never"] } },
    name: SEARCH_QUERY_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_read.invalid_utf8",
      details: { encoding: "utf-8", path: "invalid.md" },
      message: "Vault document is not valid UTF-8: invalid.md",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("search_query transport rejects excluded maxTagsPerFile input", async (t) => {
  const harness = await createHarness(t);
  const result = await harness.client.callTool({
    arguments: {
      maxTagsPerFile: 1,
      query: { "==": ["a", "a"] },
    },
    name: SEARCH_QUERY_TOOL_NAME,
  });

  assert.equal(result.isError, true);
});

test("search_query missing query is rejected by SDK input validation without sensitive disclosure", async (t) => {
  const harness = await createHarness(t);
  const result = await harness.client.callTool({
    arguments: {},
    name: SEARCH_QUERY_TOOL_NAME,
  });
  const message = readTextBlock(result.content);

  assert.equal(result.isError, true);
  assert.match(message, /Input validation error/u);
  assert.equal(message.includes(harness.vault), false);
  assert.equal(message.includes("stack"), false);
});

test("search_query unknown use-case failures become generic MCP errors", async (t) => {
  const sensitiveMessage = "sensitive search-query implementation detail";
  const harness = await createHarness(t, {
    searchQuery: async () => {
      throw new Error(sensitiveMessage);
    },
  });

  const result = await harness.client.callTool({
    arguments: { query: { "==": ["a", "a"] } },
    name: SEARCH_QUERY_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "search_query.internal_error",
      message: "search_query failed unexpectedly",
    },
  });
  assert.equal(JSON.stringify(payload).includes(sensitiveMessage), false);
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("tools/call tag_list returns deterministic names and per-file counts", async (t) => {
  const harness = await createHarness(t);
  await writeFile(
    path.join(harness.vault, "A.md"),
    ["---", "tags: [Project/Alpha]", "---", "#project #Other"].join("\n"),
  );
  await writeFile(path.join(harness.vault, "B.md"), "#PROJECT/Beta #other");

  const result = await harness.client.callTool({
    arguments: {},
    name: TAG_LIST_TOOL_NAME,
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    tags: [
      { count: 2, name: "Other" },
      { count: 2, name: "Project" },
      { count: 1, name: "Project/Alpha" },
      { count: 1, name: "PROJECT/Beta" },
    ],
  });
  assert.deepEqual(result.content, []);
});

test("tag-list budgets become stable MCP tool errors without root or stack disclosure", async (t) => {
  const harness = await createHarness(t);
  await writeFile(path.join(harness.vault, "note.md"), "#a #b");

  const result = await harness.client.callTool({
    arguments: { maxTags: 1 },
    name: TAG_LIST_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "tag_list.budget_exceeded",
      details: {
        budget: "maxTags",
        limit: 1,
        observedAtLeast: "2",
      },
      message: "tag_list exceeded its maxTags budget of 1",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("tag-list read failures reuse the stable safe-read MCP error contract", async (t) => {
  const harness = await createHarness(t);
  await writeFile(
    path.join(harness.vault, "invalid.md"),
    Buffer.from([0xc3, 0x28]),
  );

  const result = await harness.client.callTool({
    arguments: {},
    name: TAG_LIST_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "vault_read.invalid_utf8",
      details: { encoding: "utf-8", path: "invalid.md" },
      message: "Vault document is not valid UTF-8: invalid.md",
    },
  });
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("tag-list unknown failures become generic MCP errors without sensitive details", async (t) => {
  const sensitiveMessage = "sensitive tag-list implementation detail";
  const harness = await createHarness(t, {
    tagList: async () => {
      throw new Error(sensitiveMessage);
    },
  });

  const result = await harness.client.callTool({
    arguments: {},
    name: TAG_LIST_TOOL_NAME,
  });
  const payload = readTextPayload(result.content);

  assert.equal(result.isError, true);
  assert.deepEqual(payload, {
    error: {
      code: "tag_list.internal_error",
      message: "tag_list failed unexpectedly",
    },
  });
  assert.equal(JSON.stringify(payload).includes(sensitiveMessage), false);
  assertDoesNotLeakRootOrStack(payload, harness.vault);
});

test("removed search_simple is absent and cannot be invoked", async (t) => {
  const harness = await createHarness(t);
  assert.equal((await harness.client.listTools()).tools.some(tool => tool.name === "search_simple"), false);
  await assert.rejects(harness.client.callTool({ name: "search_simple", arguments: { query: "text" } }),
    /Tool search_simple not found/u);
});

test("targeted and non-boolean query results travel only in structuredContent", async (t) => {
  const harness = await createHarness(t);
  const source = "---\nstatus: done\n---\n# One\n" + "long body ".repeat(10_000);
  await writeFile(path.join(harness.vault, "note.md"), source);
  const full = await harness.client.callTool({ name: VAULT_READ_TOOL_NAME, arguments: { path: "note.md" } });
  assert.notEqual(full.isError, true, JSON.stringify(full));
  assert.deepEqual(full.content, []);
  assert.equal((full.structuredContent as {content: string}).content, source);
  const targeted = await harness.client.callTool({ name: VAULT_READ_TOOL_NAME, arguments: { path: "note.md", targetType: "frontmatter", target: "status" } });
  assert.deepEqual(targeted.structuredContent, { path: "note.md", version: computeContentVersion(source), result: "done" });
  assert.deepEqual(targeted.content, []);
  const query = await harness.client.callTool({ name: SEARCH_QUERY_TOOL_NAME, arguments: { query: {var: "frontmatter.status"} } });
  assert.notEqual(query.isError, true, JSON.stringify(query));
  assert.deepEqual(query.structuredContent, {results: [{filename: "note.md", version: computeContentVersion(source), result: "done"}]});
  assert.deepEqual(query.content, []);
});

test("all discovered tools have input/output schemas and reject unknown input fields", async (t) => {
  const harness = await createHarness(t);
  for (const tool of (await harness.client.listTools()).tools) {
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    assert.equal(tool.inputSchema["additionalProperties"], false);
    const response = await harness.client.callTool({name: tool.name, arguments: { path: "note.md", query: {var: "path"}, unknown: "field" }});
    assert.equal(response.isError, true);
  }
});

test("mutation capability exposes ten Vault tools plus help with strict schemas and correct annotations", async t => {
  const harness = await createHarness(t, { enableMutations: true });
  const tools = (await harness.client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ["obsidian_help", "search_query", "tag_list", "vault_append", "vault_delete", "vault_get_document_map", "vault_list", "vault_move", "vault_patch", "vault_read", "vault_write"]);
  for (const name of [VAULT_WRITE_TOOL_NAME, VAULT_APPEND_TOOL_NAME, VAULT_PATCH_TOOL_NAME, VAULT_MOVE_TOOL_NAME, VAULT_DELETE_TOOL_NAME]) {
    const tool = tools.find(t => t.name === name)!;
    assert.equal(tool.annotations?.readOnlyHint, false);
    assert.equal(tool.annotations?.idempotentHint, name === VAULT_WRITE_TOOL_NAME);
    assert.equal(tool.annotations?.destructiveHint, name !== VAULT_APPEND_TOOL_NAME);
    assert.equal(tool.inputSchema["additionalProperties"], false);
    assert.ok(tool.outputSchema);
  }
  const result = await harness.client.callTool({ name: VAULT_WRITE_TOOL_NAME, arguments: { path: "note.md", content: "x", force: true } });
  assert.equal(result.isError, true);
  assert.match(readTextBlock(result.content), /Input validation error/u);
});

test("write, append and generic frontmatter patch use one structured compact commit contract", async t => {
  const harness = await createHarness(t, { enableMutations: true });
  const source = "---\nstatus: draft\n---\n# Note\n" + "long body ".repeat(2000);
  const created = await harness.client.callTool({ name: VAULT_WRITE_TOOL_NAME, arguments: { path: "folder/note.md", content: source } });
  assert.notEqual(created.isError, true, JSON.stringify(created));
  assert.deepEqual(created.content, []);
  assert.ok(JSON.stringify(created.structuredContent).length < 500);
  const firstVersion = (created.structuredContent as {version: string}).version;
  assert.equal(firstVersion, computeContentVersion(source));
  const required = await harness.client.callTool({ name: VAULT_APPEND_TOOL_NAME, arguments: { path: "folder/note.md", content: "next" } });
  assert.equal(required.isError, true);
  assert.equal((required.structuredContent as {error: {code: string}}).error.code, "vault_mutation.if_match_required");
  const appended = await harness.client.callTool({ name: VAULT_APPEND_TOOL_NAME, arguments: { path: "folder/note.md", content: "next", ifMatch: firstVersion } });
  assert.notEqual(appended.isError, true, JSON.stringify(appended));
  assert.deepEqual(appended.content, []);
  const secondVersion = (appended.structuredContent as {version: string}).version;
  assert.equal(secondVersion, computeContentVersion(source + "\nnext"));
  const stale = await harness.client.callTool({ name: VAULT_APPEND_TOOL_NAME, arguments: { path: "folder/note.md", content: "twice", ifMatch: firstVersion } });
  assert.equal((stale.structuredContent as {error: {code: string}}).error.code, "vault_mutation.version_conflict");
  const patched = await harness.client.callTool({ name: VAULT_PATCH_TOOL_NAME, arguments: { path: "folder/note.md", targetType: "frontmatter", target: "status", operation: "replace", value: "done", ifMatch: secondVersion } });
  assert.notEqual(patched.isError, true, JSON.stringify(patched));
  assert.deepEqual(patched.content, []);
  const read = await harness.client.callTool({ name: VAULT_READ_TOOL_NAME, arguments: { path: "folder/note.md", targetType: "frontmatter", target: "status" } });
  assert.equal((read.structuredContent as {result: unknown}).result, "done");
  assert.equal((read.structuredContent as {version: string}).version, (patched.structuredContent as {version: string}).version);
});

test("mutation wire rejects unsafe paths, text and malformed patch instructions without leaking filesystem roots", async t => {
  const harness = await createHarness(t, { enableMutations: true });
  for (const args of [{ path: ".obsidian/config.json", content: "x" }, { path: "../escape.md", content: "x" },
    { path: "NUL.md", content: "x" }, { path: "image.png", content: "x" }, { path: "text.md", content: "\0" }]) {
    const result = await harness.client.callTool({ name: VAULT_WRITE_TOOL_NAME, arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assertDoesNotLeakRootOrStack(result, harness.vault);
  }
  await writeFile(path.join(harness.vault, "note.md"), "---\nkey: value\n---\n");
  const result = await harness.client.callTool({ name: VAULT_PATCH_TOOL_NAME, arguments: { path: "note.md", targetType: "frontmatter", target: "key", operation: "replace", content: "wrong carrier", ifMatch: computeContentVersion("---\nkey: value\n---\n") } });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as {error: {code: string}}).error.code, "vault_semantic.invalid_instruction");
});

test("filesystem permission errors remain authoritative and do not disclose host paths", async t => {
  const harness = await createHarness(t, { enableMutations: true, mutationIO: { ...nativeMutationIO,
    rename: async (_temporary, destination) => { throw Object.assign(new Error("permission denied " + destination), {code: "EACCES"}); },
  } });
  await writeFile(path.join(harness.vault, "note.md"), "old");
  const result = await harness.client.callTool({ name: VAULT_APPEND_TOOL_NAME, arguments: { path: "note.md", content: "new", ifMatch: computeContentVersion("old") } });
  assert.equal(result.isError, true);
  const payload = result.structuredContent as {error: {code: string}};
  assert.equal(payload.error.code, "vault_mutation.permission_denied");
  assert.equal((await readVaultDocument(harness.sandbox, "note.md")).content, "old");
  assertDoesNotLeakRootOrStack(result, harness.vault);
});

test("move and delete expose pinned arguments and compact structured success receipts", async t => {
  const h = await createHarness(t, { enableMutations: true });
  await writeFile(path.join(h.vault, "note.md"), "source");
  await writeFile(path.join(h.vault, "existing.md"), "old");
  const blocked = await h.client.callTool({ name: VAULT_MOVE_TOOL_NAME, arguments: { path: "note.md", destination: "existing.md" } });
  assert.equal((blocked.structuredContent as {error: {code: string}}).error.code, "vault_mutation.destination_exists");
  const moved = await h.client.callTool({ name: VAULT_MOVE_TOOL_NAME, arguments: { path: "note.md", destination: "existing.md", allowOverwrite: true } });
  assert.notEqual(moved.isError, true, JSON.stringify(moved));
  assert.deepEqual(moved.content, []);
  assert.deepEqual(moved.structuredContent, { message: "OK", oldPath: "note.md", newPath: "existing.md" });
  const trashed = await h.client.callTool({ name: VAULT_DELETE_TOOL_NAME, arguments: { path: "existing.md" } });
  assert.notEqual(trashed.isError, true, JSON.stringify(trashed));
  assert.deepEqual(trashed.content, []);
  const receipt = trashed.structuredContent as {message: string; path: string; permanent: boolean; trashPath: string};
  assert.equal(receipt.message, "OK");
  assert.equal(receipt.permanent, false);
  assert.equal(receipt.path, "existing.md");
  assert.match(receipt.trashPath, /^\.trash\//u);
  assert.equal(await readFile(path.join(h.vault, receipt.trashPath), "utf8"), "source");
  await writeFile(path.join(h.vault, "permanent.md"), "remove");
  const removed = await h.client.callTool({ name: VAULT_DELETE_TOOL_NAME, arguments: { path: "permanent.md", permanent: true } });
  assert.notEqual(removed.isError, true, JSON.stringify(removed));
  assert.deepEqual(removed.structuredContent, { message: "OK", path: "permanent.md", permanent: true });
  assert.deepEqual(await readdir(h.vault), [".trash"]);
});

test("move/delete wire rejects unsafe input, stale versions and filesystem denial without path leakage", async t => {
  const deny = async (_source: string, target?: string) => { throw Object.assign(new Error("host details " + target), {code: "EACCES"}); };
  const h = await createHarness(t, { enableMutations: true, mutationIO: { ...nativeMutationIO, rename: deny, link: deny, unlink: deny } });
  await writeFile(path.join(h.vault, "note.md"), "original");
  for (const [name, args] of [
    [VAULT_MOVE_TOOL_NAME, { path: "note.md", destination: "../escape" }],
    [VAULT_DELETE_TOOL_NAME, { path: ".trash/private" }],
    [VAULT_DELETE_TOOL_NAME, { path: "note.md", permanent: "true" }],
    [VAULT_MOVE_TOOL_NAME, { path: "note.md", destination: "new.md", allowOverwrite: true, unknown: true }],
    [VAULT_DELETE_TOOL_NAME, { path: "note.md", ifMatch: computeContentVersion("stale") }],
  ] as const) {
    const result = await h.client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assertDoesNotLeakRootOrStack(result, h.vault);
  }
  for (const [name, args] of [
    [VAULT_MOVE_TOOL_NAME, {path: "note.md", destination: "new.md"}],
    [VAULT_DELETE_TOOL_NAME, {path: "note.md"}],
    [VAULT_DELETE_TOOL_NAME, {path: "note.md", permanent: true}],
  ] as const) {
    const result = await h.client.callTool({ name, arguments: args });
    assert.equal((result.structuredContent as {error: {code: string}}).error.code, "vault_mutation.permission_denied");
    assertDoesNotLeakRootOrStack(result, h.vault);
  }
  assert.equal(await readFile(path.join(h.vault, "note.md"), "utf8"), "original");
});

interface HarnessOverrides {
  readonly getDocumentMap?: VaultDocumentMapUseCase;
  readonly readDocument?: VaultReadUseCase;
  readonly searchQuery?: SearchQueryUseCase;
  readonly tagList?: TagListUseCase;
  readonly enableMutations?: boolean;
  readonly mutationIO?: MutationIO;
}

async function createHarness(t: TestContext, overrides: HarnessOverrides = {}): Promise<{
  readonly client: Client;
  readonly sandbox: VaultPathSandbox;
  readonly vault: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-wire-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const sandbox = await VaultPathSandbox.create(vault);
  let mutations: VaultMutationStore | undefined;
  if (overrides.enableMutations) {
    mutations = await VaultMutationStore.create(sandbox, {
      ...(overrides.mutationIO === undefined ? {} : { io: overrides.mutationIO }),
    });
  }
  const tagList = overrides.tagList ?? ((options) =>
    listVaultTags(
      sandbox,
      (inputPath, readOptions) =>
        readVaultDocument(sandbox, inputPath, readOptions),
      options,
    ));
  const searchQuery = overrides.searchQuery ?? ((query, options) =>
    searchVaultQuery(
      sandbox,
      (inputPath, readOptions) =>
        readVaultDocument(sandbox, inputPath, readOptions),
      query,
      options,
    ));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveVaultMcpStdio(
    {
      getDocumentMap: overrides.getDocumentMap ?? ((inputPath, options) =>
        getVaultDocumentMap(
          (readPath, readOptions) =>
            readVaultDocument(sandbox, readPath, readOptions),
          inputPath,
          options,
        )),
      listEntries: (inputPath, options) =>
        listVaultFiles(sandbox, inputPath, options),
      readDocument: overrides.readDocument ?? ((inputPath, options) =>
        readVaultNote((p, o) => readVaultDocument(sandbox, p, o), inputPath, options)),
      searchQuery,
      tagList,
      ...(mutations === undefined ? {} : { mutations }),
    },
    { transport: serverTransport },
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });

  t.after(async () => {
    try {
      await client.close();
    } finally {
      try {
        await handle.close();
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  await client.connect(clientTransport);

  return { client, sandbox, vault };
}

function assertFiniteNumber(value: unknown, key: string): number {
  if (
    typeof value !== "object" ||
    value === null ||
    !(key in value) ||
    typeof value[key as keyof typeof value] !== "number" ||
    !Number.isFinite(value[key as keyof typeof value])
  ) {
    assert.fail(`${key} must be a finite number`);
  }

  return value[key as keyof typeof value] as number;
}

function readTextPayload(
  content: readonly { readonly text?: string; readonly type: string }[],
): unknown {
  return JSON.parse(readTextBlock(content));
}

function readTextBlock(
  content: readonly { readonly text?: string; readonly type: string }[],
): string {
  assert.equal(content.length, 1);
  const first = content[0];

  if (first?.type !== "text" || typeof first.text !== "string") {
    assert.fail("tool result must contain exactly one text block");
  }

  return first.text;
}

function assertDoesNotLeakRootOrStack(payload: unknown, vaultRoot: string): void {
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes(vaultRoot), false);
  assert.equal(serialized.includes("stack"), false);
}
