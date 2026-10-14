import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { computeContentVersion } from "../../src/core/version/content-version.js";
import { MAX_TEXT_REPLACEMENT_INPUT_BYTES } from "../../src/core/mutation/prepare-text-replacement.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-replace-text-stdio-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const client = new Client({ name: "replace-text-stdio-test", version: "1.0.0" });
  t.after(async () => { try { await client.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(".test-dist/src/stdio-main.js")], env: { OBSIDIAN_VAULT_ROOT: vault }, stderr: "pipe" }));
  return { client, vault };
}

function error(result: { structuredContent?: unknown }) {
  return (result.structuredContent as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
}

interface ObjectOutputSchema {
  readonly additionalProperties?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, { readonly const?: unknown }>>;
}

test("stdio replace-text advertises exactly four strict inputs and its compact strict receipt", async t => {
  const { client } = await fixture(t);
  const tools = (await client.listTools()).tools;
  const tool = tools.find(item => item.name === "vault_replace_text")!;
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), ["ifMatch", "newText", "oldText", "path"]);
  assert.deepEqual([...tool.inputSchema.required ?? []].sort(), ["ifMatch", "newText", "oldText", "path"]);
  assert.equal(tool.inputSchema["additionalProperties"], false);
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.match(tool.description ?? "", /unique.*case-sensitive.*literal/u);
  assert.match(tool.description ?? "", /whole-file vault_read/u);
  const output = tool.outputSchema as ObjectOutputSchema;
  assert.equal(output["additionalProperties"], false);
  assert.deepEqual([...(output["required"] ?? [])].sort(), ["beforeSizeBytes", "created", "message", "path", "replacementCount", "sizeBytes", "version"]);
  assert.deepEqual(Object.keys(output["properties"] ?? {}).sort(),
    ["beforeSizeBytes", "created", "message", "path", "replacementCount", "sizeBytes", "version", "warnings"]);
  assert.equal(output["properties"]?.["replacementCount"]?.const, 1);
  for (const name of ["vault_write", "vault_append", "vault_patch"]) {
    const schema = tools.find(item => item.name === name)!.outputSchema as ObjectOutputSchema;
    assert.equal(schema["additionalProperties"], false);
    assert.ok(schema["required"]?.includes("beforeSizeBytes"));
    assert.equal(schema["properties"]?.["replacementCount"], undefined);
  }
});

test("stdio whole-file read supplies the literal text and exact version for one byte-preserving replacement", async t => {
  const { client, vault } = await fixture(t);
  const source = "\uFEFF---\r\nstatus: draft # 保留\r\n---\r\n# Parent\r\n\r\n  old.* $& 中文  \r\n\r\n### Child\r\nkeep\r\n";
  const file = path.join(vault, "note.md");
  await writeFile(file, source);
  const read = await client.callTool({ name: "vault_read", arguments: { path: "note.md" } });
  assert.notEqual(read.isError, true, JSON.stringify(read));
  const whole = read.structuredContent as { content: string; version: string };
  assert.equal(whole.content, source);
  assert.equal(whole.version, computeContentVersion(source));
  const start = whole.content.indexOf("  old.*");
  const oldText = whole.content.slice(start, whole.content.indexOf("\r\n", start));
  const newText = "  new.* $& $` $' 中文  ";
  const expected = source.slice(0, start) + newText + source.slice(start + oldText.length);
  const replaced = await client.callTool({ name: "vault_replace_text", arguments: {
    path: "note.md", oldText, newText, ifMatch: whole.version,
  } });
  assert.notEqual(replaced.isError, true, JSON.stringify(replaced));
  assert.deepEqual(replaced.content, []);
  assert.deepEqual(replaced.structuredContent, { message: "OK", path: "note.md", version: computeContentVersion(expected),
    beforeSizeBytes: Buffer.byteLength(source), sizeBytes: Buffer.byteLength(expected), created: false, replacementCount: 1 });
  assert.deepEqual(await readFile(file), Buffer.from(expected));
  const stale = await client.callTool({ name: "vault_replace_text", arguments: {
    path: "note.md", oldText: newText, newText: "again", ifMatch: whole.version,
  } });
  assert.equal(error(stale).code, "vault_mutation.version_conflict");
  assert.equal(await readFile(file, "utf8"), expected);
  const removed = await client.callTool({ name: "vault_replace_text", arguments: {
    path: "note.md", oldText: newText, newText: "", ifMatch: computeContentVersion(expected),
  } });
  assert.notEqual(removed.isError, true, JSON.stringify(removed));
  const afterDeletion = expected.slice(0, start) + expected.slice(start + newText.length);
  assert.deepEqual(removed.structuredContent, { message: "OK", path: "note.md", version: computeContentVersion(afterDeletion),
    beforeSizeBytes: Buffer.byteLength(expected), sizeBytes: Buffer.byteLength(afterDeletion), created: false, replacementCount: 1 });
  assert.deepEqual(await readFile(file), Buffer.from(afterDeletion));
});

test("stdio replace-text rejects missing, coerced or extra inputs before any write", async t => {
  const { client, vault } = await fixture(t);
  const source = "old";
  const file = path.join(vault, "note.md");
  await writeFile(file, source);
  const valid: Record<string, unknown> = { path: "note.md", oldText: "old", newText: "new", ifMatch: computeContentVersion(source) };
  const invalid: Record<string, unknown>[] = [];
  for (const key of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[key];
    invalid.push(missing, { ...valid, [key]: null }, { ...valid, [key]: 1 }, { ...valid, [key]: true });
  }
  invalid.push({ ...valid, ifMatch: "sha256:abcd" }, { ...valid, ifMatch: "" }, { ...valid, ifMatch: "sha256:" + "A".repeat(64) });
  invalid.push({ path: "note.md", old_string: "old", new_string: "new", ifMatch: computeContentVersion(source) });
  for (const field of ["scope", "targetType", "regex", "fuzzy", "all", "index", "batch", "force"]) invalid.push({ ...valid, [field]: true });
  for (const args of invalid) {
    const result = await client.callTool({ name: "vault_replace_text", arguments: args });
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(JSON.stringify(result.content), /Input validation error/u);
  }
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(vault), ["note.md"]);
});

test("stdio replace-text matching errors are bounded and leave bytes unchanged", async t => {
  const { client, vault } = await fixture(t);
  const file = path.join(vault, "note.md");
  for (const scenario of [
    { source: "Secret Match", old: "secret match", next: "new", code: "text_not_found", details: { matchCount: 0 } },
    { source: "secret secret", old: "secret", next: "new", code: "ambiguous_text", details: { matchCountAtLeast: 2 } },
    { source: "aaa", old: "aa", next: "new", code: "ambiguous_text", details: { matchCountAtLeast: 2 } },
    { source: "secret", old: "secret", next: "secret", code: "no_change", details: {} },
    { source: "secret", old: "", next: "new", code: "invalid_replacement", details: {} },
  ]) {
    await writeFile(file, scenario.source);
    const result = await client.callTool({ name: "vault_replace_text", arguments: {
      path: "note.md", oldText: scenario.old, newText: scenario.next, ifMatch: computeContentVersion(scenario.source),
    } });
    assert.equal(result.isError, true);
    const failure = error(result);
    assert.equal(failure.code, "vault_mutation." + scenario.code);
    assert.deepEqual(failure.details, { path: "note.md", ...scenario.details });
    assert.equal(JSON.stringify(failure).includes(vault), false);
    assert.doesNotMatch(JSON.stringify(failure), /secret|Secret|stack|offset|snippet/u);
    assert.ok(JSON.stringify(failure).length < 400);
    assert.deepEqual(await readFile(file), Buffer.from(scenario.source));
    assert.deepEqual(await readdir(vault), ["note.md"]);
  }
});

test("stdio replace-text is existing-only and enforces the combined UTF-8 input budget", async t => {
  const { client, vault } = await fixture(t);
  const missing = await client.callTool({ name: "vault_replace_text", arguments: {
    path: "missing.md", oldText: "old", newText: "new", ifMatch: computeContentVersion("old"),
  } });
  assert.equal(missing.isError, true);
  assert.deepEqual(await readdir(vault), []);
  const file = path.join(vault, "note.md");
  await writeFile(file, "old");
  const fragment = "中".repeat(Math.floor(MAX_TEXT_REPLACEMENT_INPUT_BYTES / 6) + 1);
  assert.ok(fragment.length * 2 < MAX_TEXT_REPLACEMENT_INPUT_BYTES);
  assert.ok(Buffer.byteLength(fragment) * 2 > MAX_TEXT_REPLACEMENT_INPUT_BYTES);
  const tooLarge = await client.callTool({ name: "vault_replace_text", arguments: {
    path: "note.md", oldText: fragment, newText: fragment + "new", ifMatch: computeContentVersion("old"),
  } });
  assert.equal(tooLarge.isError, true);
  assert.equal(error(tooLarge).code, "vault_mutation.too_large");
  assert.equal(await readFile(file, "utf8"), "old");
});

test("stdio whole-file vault_read keeps its malformed frontmatter restriction", async t => {
  const { client, vault } = await fixture(t);
  const source = "---\nstatus: [broken\n---\nbody\n";
  const file = path.join(vault, "note.md");
  await writeFile(file, source);
  const read = await client.callTool({ name: "vault_read", arguments: { path: "note.md" } });
  assert.equal(read.isError, true);
  assert.equal(error(read).code, "vault_semantic.invalid_frontmatter");
  assert.equal(await readFile(file, "utf8"), source);
});
