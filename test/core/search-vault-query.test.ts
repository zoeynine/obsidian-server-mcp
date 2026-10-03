import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  InvalidVaultDocumentEncodingError,
  InvalidVaultSearchQueryOptionError,
  VaultDocumentTooLargeError,
  VaultSearchQueryBudgetExceededError,
  VaultSearchQuerySourceUnavailableError,
  VaultPathSandbox,
  readVaultDocument,
  searchVaultQuery,
  type SearchVaultQueryOptions,
} from "../../src/core/index.js";
import type { VaultMarkdownDocumentReader } from "../../src/core/traversal/scan-vault-markdown.js";

test("search_query shares scanner bounds and fails complete-or-error at N+1", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "A.md"), "a");
  await writeFile(path.join(fixture.vault, "B.md"), "b");
  const query = { "!=": [{ var: "path" }, "never"] };

  assert.equal((await runQuery(fixture, query, { maxResults: 2 })).length, 2);
  await assertBudget(runQuery(fixture, query, { maxResults: 1 }), "maxResults", 1, 2n);
  await assertBudget(runQuery(fixture, query, { maxFiles: 1 }), "maxFiles", 1, 2n);
  await assertBudget(runQuery(fixture, query, { maxEntries: 1 }), "maxEntries", 1, 2n);
  await assertBudget(
    runQuery(fixture, query, { maxTotalBytes: 1 }),
    "maxTotalBytes",
    1,
    2n,
  );
  await assert.rejects(
    runQuery(fixture, query, { maxFileBytes: 0 }),
    (error: unknown) =>
      error instanceof VaultDocumentTooLargeError &&
      error.inputPath === "A.md" &&
      error.maxBytes === 0,
  );
});

test("search_query skips non-Markdown files and symlinks but fails unsafe Markdown reads", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "secret");
  await writeFile(path.join(fixture.vault, "A.md"), "a");
  await writeFile(path.join(fixture.vault, "ignored.bin"), Buffer.from([0xc3, 0x28]));
  await symlink(
    outside,
    path.join(fixture.vault, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.deepEqual(
    (await runQuery(fixture, { "!=": [{ var: "path" }, "never"] })).map(
      (entry) => entry.filename,
    ),
    ["A.md"],
  );

  await writeFile(path.join(fixture.vault, "invalid.md"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    runQuery(fixture, { "!=": [{ var: "path" }, "never"] }),
    (error: unknown) =>
      error instanceof InvalidVaultDocumentEncodingError &&
      error.inputPath === "invalid.md",
  );
});

test("search_query maps an unexpected reader failure to a typed source error", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "note");
  const reader: VaultMarkdownDocumentReader = async () => {
    const error = new Error("sensitive absolute path");
    Object.assign(error, { code: "EACCES" });
    throw error;
  };

  await assert.rejects(
    searchVaultQuery(fixture.sandbox, reader, { "==": [{ var: "path" }, "note.md"] }),
    (error: unknown) =>
      error instanceof VaultSearchQuerySourceUnavailableError &&
      error.path === "note.md" &&
      error.osCode === "EACCES",
  );
});

async function assertBudget(
  promise: Promise<unknown>,
  budget: "maxEntries" | "maxFiles" | "maxResults" | "maxTotalBytes",
  limit: number,
  observedAtLeast: bigint,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof VaultSearchQueryBudgetExceededError &&
      error.budget === budget &&
      error.limit === limit &&
      error.observedAtLeast === observedAtLeast,
  );
}

async function runQuery(
  fixture: QueryFixture,
  query: unknown,
  options?: SearchVaultQueryOptions,
) {
  return searchVaultQuery(
    fixture.sandbox,
    (inputPath, readOptions) =>
      readVaultDocument(fixture.sandbox, inputPath, readOptions),
    query,
    options,
  );
}

interface QueryFixture {
  readonly root: string;
  readonly sandbox: VaultPathSandbox;
  readonly vault: string;
}

async function createFixture(t: TestContext): Promise<QueryFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-query-"));
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
