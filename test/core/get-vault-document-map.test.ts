import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  MAX_VAULT_DOCUMENT_BYTES,
  InvalidVaultDocumentReadLimitError,
  VaultPathSandbox,
  computeContentVersion,
  getVaultDocumentMap,
  readVaultDocument,
} from "../../src/core/index.js";

test("maps one safely read document and pins ranges to its exact-byte version", async (t) => {
  const fixture = await createFixture(t);
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("# 总览\r\n正文\r\n## 细节\r\n", "utf8"),
  ]);
  await writeFile(path.join(fixture.vault, "note.md"), bytes);

  const result = await getVaultDocumentMap(
    (inputPath, options) =>
      readVaultDocument(fixture.sandbox, inputPath, options),
    "note.md",
  );

  assert.equal(result.path, "note.md");
  assert.equal(result.version, computeContentVersion(bytes));
  assert.deepEqual(JSON.parse(JSON.stringify(result.headings)), { 总览: { 细节: {} } });
  assert.deepEqual(result.blocks, []);
  assert.deepEqual(result.frontmatterFields, []);
});

test("forwards read and parser bounds through separate core options", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "# A\n# B\n");
  const readCalls: Array<{
    readonly options: unknown;
    readonly path: string;
  }> = [];

  await assert.rejects(
    getVaultDocumentMap(
      async (inputPath, options) => {
        readCalls.push({ options, path: inputPath });
        return readVaultDocument(fixture.sandbox, inputPath, options);
      },
      "note.md",
      { maxBytes: 128, maxHeadings: 1 },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "too_many_headings",
  );

  assert.deepEqual(readCalls, [
    { options: { maxBytes: 128 }, path: "note.md" },
  ]);
});

test("document maps accept the safe-read cap and reject a budget one byte above it", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "# Heading\nbody\n");
  const reader = (inputPath: string, options?: { readonly maxBytes?: number }) =>
    readVaultDocument(fixture.sandbox, inputPath, options);

  const result = await getVaultDocumentMap(reader, "note.md", {
    maxBytes: MAX_VAULT_DOCUMENT_BYTES,
  });
  assert.deepEqual(Object.keys(result.headings), ["Heading"]);
  await assert.rejects(
    getVaultDocumentMap(reader, "missing.md", {
      maxBytes: MAX_VAULT_DOCUMENT_BYTES + 1,
    }),
    (error: unknown) =>
      error instanceof InvalidVaultDocumentReadLimitError &&
      error.code === "invalid_read_limit",
  );
});

async function createFixture(
  t: TestContext,
): Promise<{
  readonly sandbox: VaultPathSandbox;
  readonly vault: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-map-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);

  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  return {
    sandbox: await VaultPathSandbox.create(vault),
    vault,
  };
}
