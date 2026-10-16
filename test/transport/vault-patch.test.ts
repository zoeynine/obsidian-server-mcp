import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readToolError as error } from "./tool-error.js";
import { computeContentVersion } from "../../src/core/version/content-version.js";
import { parseFrontmatter } from "../../src/core/document/note-json.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-patch-stdio-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const client = new Client({ name: "patch-stdio-test", version: "1.0.0" });
  t.after(async () => { try { await client.close(); } finally { await rm(root, { recursive: true, force: true }); } });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(".test-dist/src/stdio-main.js")], env: { OBSIDIAN_VAULT_ROOT: vault }, stderr: "pipe" }));
  return { client, vault };
}
test("stdio heading replacement requires advertised confirmation and still enforces versioning", async t => {
  const { client, vault } = await fixture(t);
  const tool = (await client.listTools()).tools.find(item => item.name === "vault_patch")!;
  assert.equal((tool.inputSchema.properties?.["allowSubtreeReplacement"] as { type?: string })?.type, "boolean");
  const help = await client.callTool({ name: "obsidian_help", arguments: { topic: "patch" } });
  const text = (help.structuredContent as { text: string }).text;
  assert.match(text, /allowSubtreeReplacement: true/u);
  assert.match(text, /vault_semantic\.subtree_confirmation_required/u);
  assert.match(text, /within: 0/u);
  const source = "# 总览\nintro\n\n## 子节\nkeep child\n";
  const file = path.join(vault, "note.md");
  await writeFile(file, source);
  const input = { path: "note.md", targetType: "heading", target: ["总览"], operation: "replace", content: "new body", ifMatch: computeContentVersion(source) };
  for (const scope of [undefined, "content", "markerAndContent"]) {
    const result = await client.callTool({ name: "vault_patch", arguments: { ...input, ...(scope === undefined ? {} : { scope }) } });
    assert.equal(result.isError, true);
    assert.equal(error(result).code, "vault_semantic.subtree_confirmation_required");
    assert.match(error(result).message, /allowSubtreeReplacement: true/u);
    assert.equal(await readFile(file, "utf8"), source);
  }
  const malformed = await client.callTool({ name: "vault_patch", arguments: { ...input, allowSubtreeReplacement: "true" } });
  assert.equal(malformed.isError, true);
  assert.equal(Object.hasOwn(malformed, "structuredContent"), false);
  const stale = await client.callTool({ name: "vault_patch", arguments: { ...input,
    allowSubtreeReplacement: true, ifMatch: computeContentVersion("stale") } });
  assert.equal(error(stale).code, "vault_mutation.version_conflict");
  assert.equal(await readFile(file, "utf8"), source);
  const precise = await client.callTool({ name: "vault_patch", arguments: { ...input, within: 0 } });
  assert.notEqual(precise.isError, true, JSON.stringify(precise));
  assert.ok((await readFile(file, "utf8")).endsWith("## 子节\nkeep child\n"));
  const confirmed = await client.callTool({ name: "vault_patch", arguments: { ...input,
    allowSubtreeReplacement: true, ifMatch: (precise.structuredContent as { version: string }).version } });
  assert.notEqual(confirmed.isError, true, JSON.stringify(confirmed));
  const saved = await readFile(file, "utf8");
  assert.doesNotMatch(saved, /keep child/u);
  assert.equal((confirmed.structuredContent as { version: string }).version, computeContentVersion(saved));
});

test("stdio heading not-found errors explain full paths without mislabeling missing properties", async t => {
  const { client, vault } = await fixture(t);
  const source = "# 总览\n## 详情\nbody\n";
  await writeFile(path.join(vault, "note.md"), source);
  const result = await client.callTool({ name: "vault_patch", arguments: { path: "note.md", targetType: "heading",
    target: ["详情"], operation: "replace", content: "new", ifMatch: computeContentVersion(source) } });
  assert.equal(error(result).code, "vault_semantic.TargetNotFoundError");
  assert.match(error(result).message, /full heading path from the top level/u);
  assert.match(error(result).message, /\["Guide","Setup"\]/u);
  assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), source);
  const read = await client.callTool({ name: "vault_read", arguments: { path: "note.md", targetType: "heading", target: ["详情"] } });
  assert.match(error(read).message, /full heading path from the top level/u);
  const missing = await client.callTool({ name: "vault_patch", arguments: { path: "note.md", targetType: "frontmatter",
    target: "missing", operation: "replace", value: [], ifMatch: computeContentVersion(source) } });
  assert.equal(error(missing).code, "vault_semantic.TargetNotFoundError");
  assert.doesNotMatch(error(missing).message, /heading path/u);
});

test("stdio appends and prepends native arrays for flow/block YAML with omitted or explicit content scope", async t => {
  const { client, vault } = await fixture(t);
  for (const newline of ["\n", "\r\n"]) {
    for (const tags of ["tags: [mcp-smoke]\n", "tags:\n  - mcp-smoke\n"]) {
      const source = ("---\n" + tags + "type: temp # retained\n---\n# Body\n正文\n").replace(/\n/gu, newline);
      const file = path.join(vault, "note.md");
      for (const scope of [undefined, "content"]) {
        for (const operation of ["append", "prepend"]) {
          await writeFile(file, source);
          const result = await client.callTool({ name: "vault_patch", arguments: { path: "note.md", targetType: "frontmatter",
            target: "tags", operation, value: ["smoke-extra"], ifMatch: computeContentVersion(source),
            ...(scope === undefined ? {} : { scope }) } });
          assert.notEqual(result.isError, true, JSON.stringify(result));
          const saved = await readFile(file, "utf8");
          assert.deepEqual(parseFrontmatter(saved).value["tags"], operation === "append"
            ? ["mcp-smoke", "smoke-extra"] : ["smoke-extra", "mcp-smoke"]);
          assert.ok(saved.endsWith("type: temp # retained\n---\n# Body\n正文\n".replace(/\n/gu, newline)));
          if (newline === "\r\n") assert.doesNotMatch(saved, /(?<!\r)\n/u);
          assert.equal((result.structuredContent as { version: string }).version, computeContentVersion(saved));
        }
      }
      await writeFile(file, source);
      const scalar = await client.callTool({ name: "vault_patch", arguments: { path: "note.md", targetType: "frontmatter",
        target: "tags", operation: "append", value: "smoke-extra", ifMatch: computeContentVersion(source) } });
      assert.equal(error(scalar).code, "vault_semantic.MergeError");
      assert.equal(await readFile(file, "utf8"), source);
    }
  }
});
