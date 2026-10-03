import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  VaultPathError,
  VaultPathSandbox,
  parseVaultRelativePath,
} from "../../src/core/path/vault-path.js";

test("accepts canonical Vault-relative paths and an explicitly allowed root", () => {
  assert.equal(parseVaultRelativePath("notes/项目记录.md"), "notes/项目记录.md");
  assert.equal(parseVaultRelativePath("", { allowRoot: true }), "");
});

test("rejects absolute, parent, and non-canonical paths", () => {
  const rejected = [
    "/etc/passwd",
    "C:/Windows/System32",
    "C:\\Windows\\System32",
    "\\\\server\\share",
    "C:drive-relative.md",
    "../outside.md",
    "notes/../outside.md",
    "./note.md",
    "notes//note.md",
    "notes\\note.md",
    "note.md:stream",
    "NUL.md",
    "trailing. ",
  ];

  for (const input of rejected) {
    assert.throws(
      () => parseVaultRelativePath(input),
      (error: unknown) => error instanceof VaultPathError,
      input,
    );
  }
});

test("resolves existing and not-yet-created paths within the Vault", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(path.join(fixture.vault, "notes"));
  await writeFile(path.join(fixture.vault, "notes", "existing.md"), "hello");

  const sandbox = await VaultPathSandbox.create(fixture.vault);
  const existing = await sandbox.resolve("notes/existing.md", { mustExist: true });
  const future = await sandbox.resolve("notes/future.md");

  assert.equal(existing.absolutePath, path.join(fixture.vault, "notes", "existing.md"));
  assert.equal(future.absolutePath, path.join(fixture.vault, "notes", "future.md"));
});

test("rejects symbolic-link traversal out of the Vault", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "outside");
  await symlink(
    outside,
    path.join(fixture.vault, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const sandbox = await VaultPathSandbox.create(fixture.vault);

  await assert.rejects(
    sandbox.resolve("linked/secret.md", { mustExist: true }),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "symlink_traversal",
  );
});

test("requires an absolute, real-directory Vault root", async (t) => {
  const fixture = await createFixture(t);
  const rootLink = path.join(fixture.root, "vault-link");
  await symlink(
    fixture.vault,
    rootLink,
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    VaultPathSandbox.create("relative-vault"),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "invalid_root",
  );
  await assert.rejects(
    VaultPathSandbox.create(rootLink),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "invalid_root",
  );
});

test("a sandbox refuses a replaced root even if the replacement has the same path", async (t) => {
  const fixture = await createFixture(t);
  const sandbox = await VaultPathSandbox.create(fixture.vault);
  await rename(fixture.vault, path.join(fixture.root, "original"));
  await mkdir(fixture.vault);
  await writeFile(path.join(fixture.vault, "note.md"), "replacement");
  await assert.rejects(sandbox.resolve("note.md"), (error: unknown) => error instanceof VaultPathError && error.code === "invalid_root");
});

async function createFixture(
  t: TestContext,
): Promise<{ readonly root: string; readonly vault: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);

  t.after(async () => {
    await rm(root, { force: true, recursive: true });
  });

  return { root, vault };
}
