import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  MAX_VAULT_LIST_ENTRIES,
  InvalidVaultListLimitError,
  VaultDirectoryNotFoundError,
  VaultDirectoryTooLargeError,
  VaultListNotDirectoryError,
  listVaultEntries,
} from "../../src/core/list/list-vault-entries.js";
import {
  VaultPathError,
  VaultPathSandbox,
} from "../../src/core/path/vault-path.js";

test("lists root and nested directories in deterministic order", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(fixture.vault, "z-last.md"), "z");
  await mkdir(path.join(fixture.vault, "folder"));
  await writeFile(path.join(fixture.vault, "A-first.md"), "a");
  await writeFile(path.join(fixture.vault, "folder", "nested.md"), "nested");
  await symlink(
    outside,
    path.join(fixture.vault, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const root = await listVaultEntries(fixture.sandbox);
  const repeated = await listVaultEntries(fixture.sandbox, "");
  const nested = await listVaultEntries(fixture.sandbox, "folder");

  assert.equal(root.directory, "");
  assert.deepEqual(root.entries, [
    { kind: "file", name: "A-first.md", path: "A-first.md" },
    { kind: "directory", name: "folder", path: "folder" },
    { kind: "symlink", name: "linked", path: "linked" },
    { kind: "file", name: "z-last.md", path: "z-last.md" },
  ]);
  assert.deepEqual(repeated, root);
  assert.deepEqual(nested, {
    directory: "folder",
    entries: [
      {
        kind: "file",
        name: "nested.md",
        path: "folder/nested.md",
      },
    ],
  });
});

test("rejects a directory that exceeds its configured entry bound", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "one.md"), "1");
  await writeFile(path.join(fixture.vault, "two.md"), "2");
  await writeFile(path.join(fixture.vault, "three.md"), "3");

  await assert.rejects(
    listVaultEntries(fixture.sandbox, "", { maxEntries: 2 }),
    (error: unknown) =>
      error instanceof VaultDirectoryTooLargeError &&
      error.code === "too_many_entries" &&
      error.maxEntries === 2 &&
      error.observedAtLeast === 3,
  );
});

test("rejects invalid entry-limit configuration", async (t) => {
  const fixture = await createFixture(t);

  for (const maxEntries of [0, 1.5, MAX_VAULT_LIST_ENTRIES + 1]) {
    await assert.rejects(
      listVaultEntries(fixture.sandbox, "", { maxEntries }),
      (error: unknown) =>
        error instanceof InvalidVaultListLimitError &&
        error.code === "invalid_list_limit" &&
        error.maxEntries === maxEntries,
    );
  }
});

test("maps missing and non-directory targets to typed list errors", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "note");

  await assert.rejects(
    listVaultEntries(fixture.sandbox, "missing"),
    (error: unknown) =>
      error instanceof VaultDirectoryNotFoundError && error.code === "not_found",
  );
  await assert.rejects(
    listVaultEntries(fixture.sandbox, "note.md"),
    (error: unknown) =>
      error instanceof VaultListNotDirectoryError &&
      error.code === "not_directory",
  );
});

test("maps file-as-parent paths to not-found on every host platform", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "note");

  await assert.rejects(
    listVaultEntries(fixture.sandbox, "note.md/nested"),
    (error: unknown) =>
      error instanceof VaultDirectoryNotFoundError &&
      error.code === "not_found" &&
      error.inputPath === "note.md/nested",
  );
});

test("normalizes POSIX ENOTDIR during initial resolution without hiding other failures", async (t) => {
  const fixture = await createFixture(t);
  const resolve = t.mock.method(fixture.sandbox, "resolve", async () => {
    throw Object.assign(new Error("Synthetic POSIX file-as-parent failure"), {
      code: "ENOTDIR",
    });
  });

  await assert.rejects(
    listVaultEntries(fixture.sandbox, "note.md/nested"),
    (error: unknown) =>
      error instanceof VaultDirectoryNotFoundError &&
      error.code === "not_found",
  );

  const permissionError = Object.assign(new Error("Permission denied"), {
    code: "EACCES",
  });
  resolve.mock.mockImplementation(async () => { throw permissionError; });
  await assert.rejects(
    listVaultEntries(fixture.sandbox, "restricted"),
    (error: unknown) => error === permissionError,
  );
});

test("never follows a symlink supplied as the list target", async (t) => {
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
    listVaultEntries(fixture.sandbox, "linked"),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "symlink_traversal",
  );
  await assert.rejects(
    listVaultEntries(fixture.sandbox, "../outside"),
    (error: unknown) =>
      error instanceof VaultPathError && error.code === "parent_traversal",
  );
});

async function createFixture(
  t: TestContext,
): Promise<{
  readonly root: string;
  readonly sandbox: VaultPathSandbox;
  readonly vault: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-list-"));
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
