import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";

import {
  InvalidVaultDocumentEncodingError,
  VaultDocumentTooLargeError,
  readVaultDocument,
} from "../../src/core/file/read-vault-document.js";
import {
  VaultPathSandbox,
  parseVaultRelativePath,
} from "../../src/core/path/vault-path.js";
import { extractDocumentTags } from "../../src/core/tag/extract-document-tags.js";
import {
  InvalidVaultTagListOptionError,
  VaultTagListBudgetExceededError,
  VaultTagListSourceUnavailableError,
  listVaultTags,
  type ListVaultTagsOptions,
} from "../../src/core/tag/list-vault-tags.js";

test("extracts supported frontmatter lists and conservative inline tags", () => {
  const block = [
    "---",
    "tags:",
    "  - Project/Alpha",
    "  - \"#Quoted\"",
    "title: \"#not-a-tag\"",
    "---",
    "# Heading with #heading-tag",
    "Body #inline #y1984 #中文/子 #🔥/hot #1984.",
  ].join("\n");
  const flow = [
    "---",
    "tags: [one, 'Two/Nested', \"#three\"] # supported flow list",
    "---",
  ].join("\r\n");

  assert.deepEqual(extractDocumentTags(block), [
    "Project/Alpha",
    "Quoted",
    "heading-tag",
    "inline",
    "y1984",
    "中文/子",
    "🔥/hot",
  ]);
  assert.deepEqual(extractDocumentTags(flow), ["one", "Two/Nested", "three"]);
});

test("unmatched and escaped backticks remain literal while complete spans suppress tags", () => {
  const source = [
    "Unmatched `literal #same-line",
    "Later #later-line",
    "Escaped \\`literal` #after-escaped",
    "Escaped closer `code \\` #inside ` suffix #outside",
    "Even closer `#hidden \\\\` suffix #after-even",
    "Mismatched ``#not-code` then #after-mismatch",
    "Valid `#inside-one` #after-one",
    "Valid ``#inside-two` still-inside`` #after-two",
  ].join("\n");

  assert.deepEqual(extractDocumentTags(source), [
    "same-line",
    "later-line",
    "after-escaped",
    "outside",
    "after-even",
    "after-mismatch",
    "after-one",
    "after-two",
  ]);
});

test("rejects invalid backtick fences and resumes after valid backtick and tilde fences", () => {
  const source = [
    "```lang`invalid",
    "Visible #after-invalid",
    "```md",
    "Inside #hidden-backtick",
    "```",
    "Visible #after-backtick",
    "~~~ text",
    "Inside #hidden-tilde",
    "~~~",
    "Visible #after-tilde",
  ].join("\n");

  assert.deepEqual(extractDocumentTags(source), [
    "after-invalid",
    "after-backtick",
    "after-tilde",
  ]);
});

test("parses supported YAML flow lists all-or-nothing with one trailing comma", () => {
  assert.deepEqual(
    extractDocumentTags("---\ntags: [alpha, 'Beta/Nested',]\n---"),
    ["alpha", "Beta/Nested"],
  );
  assert.deepEqual(extractDocumentTags("---\ntags: []\n---"), []);
  assert.deepEqual(
    extractDocumentTags("---\ntags: [alpha] # supported comment\n---"),
    ["alpha"],
  );
  assert.deepEqual(
    extractDocumentTags("---\ntags: [\"\\u0061lpha\"]\n---"),
    ["alpha"],
  );

  const malformedProperties = [
    "tags: [alpha,,beta]",
    "tags: [alpha,,]",
    "tags: [,alpha]",
    "tags: [alpha, ,beta]",
    "tags: [alpha, [beta]]",
    "tags: [alpha beta]",
    "tags: [alpha",
    "tags: [alpha]]",
    "tags: [alpha]#junk",
    "tags: [alpha] junk",
    "tags: [alpha, \"unterminated]",
    "tags: [alpha, #comment]",
    "tags: [alpha, 1984]",
  ];
  for (const property of malformedProperties) {
    const source = ["---", property, "---", "Body #body"].join("\n");
    assert.deepEqual(extractDocumentTags(source), ["body"], property);
  }
});

test("excludes code, comments, URL fragments, heading markers, and joined hashes", () => {
  const source = [
    "# Heading",
    "`#inline-code` and ``#other-code``",
    "```md",
    "#fenced",
    "```",
    "~~~",
    "#also-fenced",
    "~~~",
    "<!-- #comment -->",
    "<!--",
    "#multiline-comment",
    "-->",
    "https://example.test/#fragment?q=#query",
    "[link](https://example.test/#destination)",
    "word#joined \\#escaped ###not-a-tag",
    "Visible #actual and (#parent/child).",
  ].join("\n");

  assert.deepEqual(extractDocumentTags(source), ["actual", "parent/child"]);
  assert.deepEqual(extractDocumentTags("---\ntags:\n  - \"#unfinished\""), []);
});

test("lists tags deterministically with per-file deduplication and parent counts", async (t) => {
  const fixture = await createFixture(t);
  await mkdir(path.join(fixture.vault, "folder"));
  await writeFile(
    path.join(fixture.vault, "z.md"),
    "#PROJECT/Beta #project/beta #Other",
  );
  await writeFile(
    path.join(fixture.vault, "A.md"),
    [
      "---",
      "tags: [Project/Alpha, project]",
      "---",
      "#project/alpha #PROJECT",
    ].join("\n"),
  );
  await writeFile(path.join(fixture.vault, "folder", "nested.MD"), "#other");

  const result = await runList(fixture);

  assert.deepEqual(result, {
    tags: [
      { count: 2, name: "other" },
      { count: 2, name: "Project" },
      { count: 1, name: "Project/Alpha" },
      { count: 1, name: "PROJECT/Beta" },
    ],
  });
});

test("never follows symlinks and skips unrelated non-Markdown bytes", async (t) => {
  const fixture = await createFixture(t);
  const outside = path.join(fixture.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.md"), "#outside");
  await symlink(
    outside,
    path.join(fixture.vault, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(path.join(fixture.vault, "binary.dat"), Buffer.from([0xc3, 0x28]));
  await writeFile(path.join(fixture.vault, "visible.md"), "#inside");

  assert.deepEqual(await runList(fixture), {
    tags: [{ count: 1, name: "inside" }],
  });
});

test("recognizes leading frontmatter while preserving the safe reader UTF-8 BOM", async (t) => {
  const fixture = await createFixture(t);
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("---\ntags: [Bom/Frontmatter]\n---\n", "utf8"),
  ]);
  await writeFile(path.join(fixture.vault, "bom.md"), source);

  assert.deepEqual(await runList(fixture), {
    tags: [
      { count: 1, name: "Bom" },
      { count: 1, name: "Bom/Frontmatter" },
    ],
  });
});

test("enforces maxTags when nested ancestors alone cross the bound", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "nested.md"), "#Parent/Child/Leaf");

  await assertBudget(runList(fixture, { maxTags: 2 }), "maxTags", 2, 3n);
});

test("rejects a safe-reader result whose canonical source path changed", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "note.md"), "#tag");

  await assert.rejects(
    listVaultTags(fixture.sandbox, async (inputPath, options) => {
      const document = await readVaultDocument(fixture.sandbox, inputPath, options);
      return { ...document, path: parseVaultRelativePath("different.md") };
    }),
    (error: unknown) =>
      error instanceof VaultTagListSourceUnavailableError &&
      error.path === "note.md",
  );
});

test("enforces traversal, file, total-byte, and unique-tag bounds", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(path.join(fixture.vault, "A.md"), "#a");
  await writeFile(path.join(fixture.vault, "B.md"), "#b");

  await assertBudget(runList(fixture, { maxEntries: 1 }), "maxEntries", 1, 2n);
  await assertBudget(runList(fixture, { maxFiles: 1 }), "maxFiles", 1, 2n);
  await assertBudget(
    runList(fixture, { maxTotalBytes: 2 }),
    "maxTotalBytes",
    2,
    4n,
  );
  await assertBudget(runList(fixture, { maxTags: 1 }), "maxTags", 1, 2n);
  await assert.rejects(
    runList(fixture, { maxFileBytes: 1 }),
    (error: unknown) =>
      error instanceof VaultDocumentTooLargeError &&
      error.inputPath === "A.md" &&
      error.maxBytes === 1 &&
      error.observedSizeBytes === 2n,
  );
});

test("rejects invalid resource options and invalid UTF-8 Markdown explicitly", async (t) => {
  const fixture = await createFixture(t);

  await assert.rejects(
    runList(fixture, { maxTags: 0 }),
    (error: unknown) =>
      error instanceof InvalidVaultTagListOptionError &&
      error.option === "maxTags" &&
      error.value === 0,
  );

  await writeFile(path.join(fixture.vault, "invalid.md"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    runList(fixture),
    (error: unknown) =>
      error instanceof InvalidVaultDocumentEncodingError &&
      error.inputPath === "invalid.md",
  );
});

async function assertBudget(
  promise: Promise<unknown>,
  budget: "maxEntries" | "maxFiles" | "maxTags" | "maxTotalBytes",
  limit: number,
  observedAtLeast: bigint,
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof VaultTagListBudgetExceededError &&
      error.code === "budget_exceeded" &&
      error.budget === budget &&
      error.limit === limit &&
      error.observedAtLeast === observedAtLeast,
  );
}

async function runList(fixture: TagFixture, options?: ListVaultTagsOptions) {
  return listVaultTags(
    fixture.sandbox,
    (inputPath, readOptions) =>
      readVaultDocument(fixture.sandbox, inputPath, readOptions),
    options,
  );
}

interface TagFixture {
  readonly root: string;
  readonly sandbox: VaultPathSandbox;
  readonly vault: string;
}

async function createFixture(t: TestContext): Promise<TagFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-server-mcp-tags-"));
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
