import * as assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  DEFAULT_MAX_VAULT_DOCUMENT_BYTES,
  MAX_VAULT_DOCUMENT_BYTES,
  InvalidVaultDocumentEncodingError,
  InvalidVaultDocumentReadLimitError,
  VaultDocumentNotFoundError,
  VaultDocumentNotRegularFileError,
  VaultDocumentTooLargeError,
  readVaultDocument,
} from "../../src/core/file/read-vault-document.js";
import {
  VaultPathError,
  VaultPathSandbox,
} from "../../src/core/path/vault-path.js";
import { computeContentVersion } from "../../src/core/version/content-version.js";

test("reads a regular UTF-8 document without changing its text", async (t) => {
  const fixture = await createFixture(t);
  const bytes = Buffer.from("# Project\r\n\r\n中文内容\n", "utf8");
  await writeFile(path.join(fixture.vault, "note.md"), bytes);

  const result = await readVaultDocument(fixture.sandbox, "note.md");

  assert.equal(result.path, "note.md");
  assert.equal(result.content, "# Project\r\n\r\n中文内容\n");
  assert.equal(result.sizeBytes, bytes.byteLength);
  assert.equal(result.version, computeContentVersion(bytes));
  assert.equal(Number.isFinite(result.modifiedAtMs), true);
});

test("versions exact bytes while applying the explicit UTF-8 BOM text policy", async (t) => {
  const fixture = await createFixture(t);
  const plainBytes = Buffer.from("same text", "utf8");
  const bomBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plainBytes]);
  await writeFile(path.join(fixture.vault, "plain.md"), plainBytes);
  await writeFile(path.join(fixture.vault, "bom.md"), bomBytes);

  const plain = await readVaultDocument(fixture.sandbox, "plain.md");
  const withBom = await readVaultDocument(fixture.sandbox, "bom.md");

  assert.equal(plain.content, "same text");
  assert.equal(withBom.content, "\uFEFFsame text");
  assert.equal(withBom.version, computeContentVersion(bomBytes));
  assert.notEqual(withBom.version, plain.version);
});

test("rejects invalid UTF-8 instead of replacing malformed bytes", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(
    path.join(fixture.vault, "invalid.md"),
    Buffer.from([0x76, 0x61, 0x75, 0x6c, 0x74, 0xc3, 0x28]),
  );

  await assert.rejects(
    readVaultDocument(fixture.sandbox, "invalid.md"),
    (error: unknown) =>
      error instanceof InvalidVaultDocumentEncodingError &&
      error.code === "invalid_utf8" &&
      error.encoding === "utf-8",
  );
});

test("enforces an inclusive configurable byte limit", async (t) => {
  const fixture = await createFixture(t);
  const bytes = Buffer.from("12345", "utf8");
  await writeFile(path.join(fixture.vault, "bounded.md"), bytes);

  const atLimit = await readVaultDocument(fixture.sandbox, "bounded.md", {
    maxBytes: bytes.byteLength,
  });
  assert.equal(atLimit.sizeBytes, bytes.byteLength);

  await assert.rejects(
    readVaultDocument(fixture.sandbox, "bounded.md", { maxBytes: 4 }),
    (error: unknown) =>
      error instanceof VaultDocumentTooLargeError &&
      error.code === "too_large" &&
      error.maxBytes === 4 &&
      error.observedSizeBytes === 5n,
  );
});

test("keeps the default bound and accepts exactly 64 MiB but rejects a larger file", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(DEFAULT_MAX_VAULT_DOCUMENT_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_VAULT_DOCUMENT_BYTES, 64 * 1024 * 1024);
  const bytes = Buffer.alloc(MAX_VAULT_DOCUMENT_BYTES, "a");
  const filePath = path.join(fixture.vault, "at-cap.md");
  await writeFile(filePath, bytes);

  await assert.rejects(
    readVaultDocument(fixture.sandbox, "at-cap.md"),
    (error: unknown) =>
      error instanceof VaultDocumentTooLargeError &&
      error.maxBytes === DEFAULT_MAX_VAULT_DOCUMENT_BYTES,
  );

  const result = await readVaultDocument(fixture.sandbox, "at-cap.md", {
    maxBytes: MAX_VAULT_DOCUMENT_BYTES,
  });
  assert.equal(result.sizeBytes, MAX_VAULT_DOCUMENT_BYTES);
  assert.equal(result.content.length, MAX_VAULT_DOCUMENT_BYTES);
  assert.equal(result.version, computeContentVersion(bytes));

  await appendFile(filePath, "b");
  await assert.rejects(
    readVaultDocument(fixture.sandbox, "at-cap.md", {
      maxBytes: MAX_VAULT_DOCUMENT_BYTES,
    }),
    (error: unknown) =>
      error instanceof VaultDocumentTooLargeError &&
      error.maxBytes === MAX_VAULT_DOCUMENT_BYTES &&
      error.observedSizeBytes === BigInt(MAX_VAULT_DOCUMENT_BYTES + 1),
  );
});

test("rejects a caller budget above 64 MiB before resolving any Vault path", async (t) => {
  const fixture = await createFixture(t);
  const resolve = t.mock.method(fixture.sandbox, "resolve", async () => {
    throw new Error("An invalid read budget must not access the Vault");
  });

  for (const maxBytes of [MAX_VAULT_DOCUMENT_BYTES + 1, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      readVaultDocument(fixture.sandbox, "missing.md", { maxBytes }),
      (error: unknown) =>
        error instanceof InvalidVaultDocumentReadLimitError &&
        error.code === "invalid_read_limit" &&
        error.maxBytes === maxBytes,
    );
  }
  assert.equal(resolve.mock.callCount(), 0);
});

test("rejects invalid byte-limit configuration", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "content");

  for (const maxBytes of [-1, 1.5, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      readVaultDocument(fixture.sandbox, "note.md", { maxBytes }),
      (error: unknown) =>
        error instanceof InvalidVaultDocumentReadLimitError &&
        error.code === "invalid_read_limit" &&
        error.maxBytes === maxBytes,
    );
  }
});

test("rejects directories as non-regular documents", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(path.join(fixture.vault, "folder"));

  await assert.rejects(
    readVaultDocument(fixture.sandbox, "folder"),
    (error: unknown) =>
      error instanceof VaultDocumentNotRegularFileError &&
      error.code === "not_regular_file" &&
      error.actualType === "directory",
  );
});

test("maps missing files to a typed read error", async (t) => {
  const fixture = await createFixture(t);

  await assert.rejects(
    readVaultDocument(fixture.sandbox, "missing.md"),
    (error: unknown) =>
      error instanceof VaultDocumentNotFoundError && error.code === "not_found",
  );
});

test("preserves path sandbox rejection for parent and symlink traversal", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "outside");
  await symlink(
    outside,
    path.join(fixture.vault, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    readVaultDocument(fixture.sandbox, "../outside/secret.md"),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "parent_traversal",
  );
  await assert.rejects(
    readVaultDocument(fixture.sandbox, "linked/secret.md"),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "symlink_traversal",
  );
});

async function createFixture(
  t: TestContext,
): Promise<{
  readonly root: string;
  readonly sandbox: VaultPathSandbox;
  readonly vault: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-read-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);

  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  return {
    root,
    sandbox: await VaultPathSandbox.create(vault),
    vault,
  };
}
