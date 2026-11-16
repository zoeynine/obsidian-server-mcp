import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { buildModel, headingTreePaths, projectMap, TargetNotFoundError } from "markdown-patch";
import { VaultSemanticError, withoutBom } from "../../src/core/document/note-json.js";
import type { VaultDocumentReadResult } from "../../src/core/file/read-vault-document.js";
import { nativeMutationIO, type MutationIO } from "../../src/core/mutation/mutation-io.js";
import { VaultMutationError, VaultMutationStore } from "../../src/core/mutation/vault-mutations.js";
import { parseVaultRelativePath, VaultPathSandbox } from "../../src/core/path/vault-path.js";
import { prepareHeadingInsertion } from "../../src/core/patch/prepare-heading-insertion.js";
import {
  computeContentVersion, ConflictingVersionPreconditionsError, getVersionGuard,
  VersionConflictError, VersionGuardConflictError,
} from "../../src/core/version/content-version.js";

function document(content: string): VaultDocumentReadResult {
  const version = computeContentVersion(content);
  return { path: parseVaultRelativePath("note.md"), content, version, versionGuard: getVersionGuard(version),
    modifiedAtMs: 0, sizeBytes: Buffer.byteLength(content) };
}

function insert(source: string, input: Record<string, unknown>) {
  return prepareHeadingInsertion(document(source), { ifMatch: computeContentVersion(source), ...input });
}

function headings(source: string) {
  return JSON.parse(JSON.stringify(projectMap(buildModel(withoutBom(source))).headings)) as Record<string, Record<string, unknown>>;
}

function insertedPath(source: string): string[] {
  const candidates = headingTreePaths(projectMap(buildModel(withoutBom(source))).headings)
    .filter(target => target.at(-1) === "Inserted");
  assert.equal(candidates.length, 1);
  return candidates[0]!;
}

const semantic = (code: string) => (error: unknown) => error instanceof VaultSemanticError && error.code === code;
const child = { parent: ["Root"], place: "last", title: "Inserted", body: "new body" };

async function fixture(t: TestContext, io: MutationIO = nativeMutationIO) {
  const temporary = path.resolve(".test-dist", ".test-tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "obsidian-heading-insertion-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = await VaultPathSandbox.create(vault);
  const store = await VaultMutationStore.create(sandbox, { io });
  return { vault, sandbox, store };
}

test("structured heading placement selects direct sibling positions and root without caller level arithmetic", () => {
  const source = "# Root\nintro ^intro\n\n## A\nA body ^a\n\n### A child\nkeep child\n\n## B\nB body\n\n# Outside\nstay\n";
  const cases = [
    { place: "first", expected: ["Inserted", "A", "B"] },
    { place: "last", expected: ["A", "B", "Inserted"] },
    { place: { before: ["Root", "B"] }, expected: ["A", "Inserted", "B"] },
    { place: { after: ["Root", "A"] }, expected: ["A", "Inserted", "B"] },
  ];
  for (const { place, expected } of cases) {
    const { document: next, warnings, headingPath, headingLevel } = insert(source, { ...child, place });
    assert.deepEqual(Object.keys(headings(next)["Root"]!), expected, JSON.stringify(place));
    assert.deepEqual(headings(next)["Root"]!["A"], { "A child": {} });
    assert.ok(next.startsWith("# Root\nintro ^intro\n\n"));
    assert.ok(next.includes("## A\nA body ^a\n\n### A child\nkeep child\n"));
    assert.ok(next.includes("## Inserted\n"));
    assert.ok(next.endsWith("# Outside\nstay\n"));
    assert.deepEqual(warnings, []);
    assert.deepEqual(headingPath, ["Root", "Inserted"]);
    assert.equal(headingLevel, 2);
  }
  for (const { parent, place, expected } of [
    { parent: [], place: "first", expected: ["Inserted", "Root", "Outside"] },
    { parent: null, place: "last", expected: ["Root", "Outside", "Inserted"] },
  ]) {
    const { document: next, headingPath, headingLevel } = insert(source, { ...child, parent, place, body: "" });
    assert.deepEqual(Object.keys(headings(next)), expected);
    assert.match(next, /^# Inserted\r?$/mu);
    assert.deepEqual(headingPath, ["Inserted"]);
    assert.equal(headingLevel, 1);
  }
});

test("insertion uses the actual parent level and preserves exact duplicate and numeric map addresses", () => {
  const skipped = "# Root\n### Deep\nkeep body\n# Outside\nstay\n";
  const skippedResult = insert(skipped, { ...child, parent: ["Root", "Deep"] });
  const next = skippedResult.document;
  assert.match(next, /^#### Inserted$/mu);
  assert.deepEqual(headings(next), { Root: { Deep: { Inserted: {} } }, Outside: {} });
  assert.deepEqual(skippedResult.headingPath, insertedPath(next));
  assert.equal(skippedResult.headingLevel, 4);

  const repeated = "# Root\n## Group\nfirst parent\n### First\nkeep first\n## Group\nsecond parent\n### Second\nkeep second\n# Outside\nstay\n";
  const groups = Object.keys(headings(repeated)["Root"]!);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0], groups[1]);
  const duplicateResult = insert(repeated, { ...child, parent: ["Root", groups[1]!] });
  const duplicate = duplicateResult.document;
  assert.deepEqual(headings(duplicate)["Root"]![groups[0]!], { First: {} });
  assert.deepEqual(headings(duplicate)["Root"]![groups[1]!], { Second: {}, Inserted: {} });
  assert.ok(duplicate.startsWith(repeated.slice(0, repeated.indexOf("second parent"))));
  assert.deepEqual(duplicateResult.headingPath, insertedPath(duplicate));
  assert.equal(duplicateResult.headingLevel, 3);

  const numeric = "# Root\n## 10\nten\n## 2\ntwo\n# Outside\nstay\n";
  const numericResult = insert(numeric, { ...child, parent: ["Root", "2"] });
  const numbered = numericResult.document;
  assert.deepEqual(headings(numbered)["Root"]!["10"], {});
  assert.deepEqual(headings(numbered)["Root"]!["2"], { Inserted: {} });
  assert.deepEqual(numericResult.headingPath, insertedPath(numbered));
  assert.equal(numericResult.headingLevel, 3);
  const emptyParent = insert("# \nbody\n", { ...child, parent: [""] });
  assert.deepEqual(emptyParent.headingPath, insertedPath(emptyParent.document));
  assert.deepEqual(emptyParent.headingPath, ["", "Inserted"]);
  assert.equal(emptyParent.headingLevel, 2);
});

test("empty documents, frontmatter-only documents and missing final line endings keep their existing bytes", () => {
  for (const source of ["", "\uFEFF", "---\nkey: 'value' # retained\n---", "intro without newline"]) {
    const next = insert(source, { ...child, parent: null, body: "" }).document;
    assert.ok(next.startsWith(source));
    assert.deepEqual(headings(next), { Inserted: {} });
  }
  for (const source of ["# Root", "# Root\nbody without newline", "Root\n====", "# Root\r\nbody without newline"]) {
    const next = insert(source, child).document;
    assert.ok(next.startsWith(source));
    assert.deepEqual(headings(next), { Root: { Inserted: {} } });
  }
});

test("duplicate sibling titles and non-child placement anchors fail explicitly", () => {
  const source = "# Root\n## A\n### Nested\nkeep\n## B\nbody\n# Outside\nstay\n";
  assert.throws(() => insert(source, { ...child, title: "A" }), semantic("duplicate_heading"));
  for (const input of [
    { ...child, parent: ["Nested"] },
    { ...child, parent: ["Missing"] },
    { ...child, place: { before: ["Outside"] } },
    { ...child, place: { after: ["Root", "A", "Nested"] } },
    { ...child, place: { before: ["Root", "Missing"] } },
  ]) assert.throws(() => insert(source, input), TargetNotFoundError);
});

test("relative ATX headings form a complete subtree while skipped levels and non-heading body bytes remain intact", () => {
  const source = "# Root\nintro\n## Existing\nkeep\n# Outside\nstay\n";
  const literal = "```md\n# A fenced heading\n```\n\n<!--\n## A comment heading\n-->\n\n<script>\n### A script heading\n</script>\n\n> # A quoted heading\n> ## A nested quote\n\nA paragraph ^new-block";
  const body = "intro\n\n# Child\nchild body\n\n## Grandchild\ngrandchild body\n\n#### Skipped\n" + literal;
  const next = insert(source, { ...child, body }).document;
  assert.ok(next.includes("## Inserted\n\nintro\n\n### Child\nchild body\n\n#### Grandchild\ngrandchild body\n\n###### Skipped\n"));
  assert.ok(next.includes(literal));
  assert.deepEqual(headings(next), { Root: { Existing: {}, Inserted: { Child: { Grandchild: { Skipped: {} } } } }, Outside: {} });
  assert.deepEqual(projectMap(buildModel(next)).blocks, ["new-block"]);
  assert.ok(next.startsWith(source.slice(0, source.indexOf("# Outside"))));
  assert.ok(next.endsWith("# Outside\nstay\n"));
});

test("single-line setext headings convert at their relative levels while unrepresentable labels fail explicitly", () => {
  const source = "# Root\r\nintro\r\n# Outside\r\nstay\r\n";
  const body = "Equal child\r\n====\r\nchild body\r\n\r\nDash grandchild\r\n-----\r\ngrandchild body";
  const next = insert(source, { ...child, body }).document;
  assert.ok(next.includes("### Equal child\r\nchild body\r\n\r\n#### Dash grandchild\r\ngrandchild body"));
  assert.doesNotMatch(next, /(?<!\r)\n/u);
  assert.deepEqual(headings(next), { Root: { Inserted: { "Equal child": { "Dash grandchild": {} } } }, Outside: {} });
  assert.throws(() => insert(source, { ...child, body: "two\nlines\n====\nbody" }), semantic("unsupported_heading"));
  assert.throws(() => insert(source, { ...child, body: "Child ###\n====\nbody" }), semantic("unsupported_heading"));
});

test("body parsing treats a leading delimiter as content and checks duplicate siblings within each new branch", () => {
  const source = "# Root\nintro\n# Outside\nstay\n";
  const next = insert(source, { ...child, body: "---\n\n# Child\nbody" }).document;
  assert.ok(next.includes("---\n\n### Child\nbody"));
  assert.deepEqual(headings(next), { Root: { Inserted: { Child: {} } }, Outside: {} });
  for (const body of ["# 2\none\n# 2\ntwo", "# Branch\n## Same\none\n## Same\ntwo"]) {
    assert.throws(() => insert(source, { ...child, body }), semantic("duplicate_heading"));
  }
  const branches = insert(source, { ...child, body: "# First\n## Same\none\n# Second\n## Same\ntwo" }).document;
  assert.deepEqual(headings(branches), {
    Root: { Inserted: { First: { Same: {} }, Second: { Same: {} } } }, Outside: {},
  });
});

test("unclosed source or inserted opaque regions cannot hide headings or consume existing suffix sections", () => {
  for (const opening of ["```md\n", "<script>\n"]) {
    const source = "# Root\n" + opening + "unclosed body\n";
    assert.throws(() => insert(source, child), semantic("unsafe_heading_insertion"));
  }
  const source = "# Root\nintro\n## Existing\nkeep body ^keep\n# Outside\nstay\n";
  for (const body of ["# Child\n```md\nunclosed body", "<!--\nunclosed comment", "<script>\nunclosed script"]) {
    assert.throws(() => insert(source, { ...child, place: "first", body }), semantic("unsafe_heading_insertion"));
  }
});

test("inserting before skipped-level siblings rejects reparenting while safe trailing insertion succeeds", () => {
  const source = "# Root\nintro\n### A\na body ^a\n### B\nb body ^b\n# Outside\nstay\n";
  const subtree = { ...child, body: "# Child\n## Grandchild\nbody" };
  for (const place of ["first", { before: ["Root", "B"] }]) {
    assert.throws(() => insert(source, { ...subtree, place }), semantic("unsafe_heading_insertion"));
  }
  const next = insert(source, subtree).document;
  assert.deepEqual(headings(next), { Root: { A: {}, B: {}, Inserted: { Child: { Grandchild: {} } } }, Outside: {} });
  assert.ok(next.startsWith(source.slice(0, source.indexOf("# Outside"))));
  assert.ok(next.endsWith("# Outside\nstay\n"));
  assert.deepEqual(projectMap(buildModel(next)).blocks, ["a", "b"]);
});

test("title and input validation reject malformed instructions before producing output", () => {
  const source = "# Root\nbody\n";
  for (const title of ["", " ", " leading", "trailing ", "line\nbreak", "line\rbreak", "Title ###"]) {
    assert.throws(() => insert(source, { ...child, title }), semantic("invalid_heading_title"), JSON.stringify(title));
  }
  for (const input of [
    { ...child, parent: "Root" },
    { ...child, place: "middle" },
    { ...child, place: { before: null } },
    { ...child, place: { before: ["Root"], after: ["Root"] } },
    { ...child, body: 3 },
    { ...child, extra: true },
  ]) assert.throws(() => insert(source, input), semantic("invalid_heading_insertion"));
  assert.throws(() => insert(source, { ...child, body: "x".repeat(4 * 1024 * 1024) }), (error: unknown) => {
    assert.ok(error instanceof VaultSemanticError);
    assert.match(error.message, /4 MiB/u);
    return true;
  });
});

test("H6, duplicate, unsafe, missing and stale preconditions never stage or publish insertion bytes", async t => {
  let writes = 0; let publishes = 0;
  const f = await fixture(t, { ...nativeMutationIO,
    writeFile: async (handle, bytes) => { writes++; await nativeMutationIO.writeFile(handle, bytes); },
    rename: async (from, to) => { publishes++; await nativeMutationIO.rename(from, to); },
  });
  const file = path.join(f.vault, "note.md");
  const cases = [
    { source: "# Root\n###### Leaf\nbody\n", input: { ...child, parent: ["Root", "Leaf"] }, code: "heading_depth_overflow" },
    { source: "# Root\n##### Parent\nbody\n", input: { ...child, parent: ["Root", "Parent"], body: "# Child\nbody" }, code: "heading_depth_overflow" },
    { source: "# Root\n## Inserted\nbody\n", input: child, code: "duplicate_heading" },
    { source: "# Root\nbody\n", input: { ...child, body: "# Branch\n## 2\none\n## 2\ntwo" }, code: "duplicate_heading" },
    { source: "# Root\n### A\nkeep\n# Outside\nstay\n", input: { ...child, place: "first" }, code: "unsafe_heading_insertion" },
  ];
  for (const { source, input, code } of cases) {
    await writeFile(file, source);
    await assert.rejects(f.store.insertHeading("note.md", { ...input, ifMatch: computeContentVersion(source) }), semantic(code));
    assert.equal(await readFile(file, "utf8"), source);
  }
  const source = "# Root\nbody\n";
  await writeFile(file, source);
  const version = computeContentVersion(source);
  await assert.rejects(f.store.insertHeading("note.md", child), (error: unknown) =>
    error instanceof VaultMutationError && error.code === "if_match_required");
  await assert.rejects(f.store.insertHeading("note.md", { ...child, ifMatch: computeContentVersion("stale") }), VersionConflictError);
  await assert.rejects(f.store.insertHeading("note.md", { ...child,
    ifMatchGuard: getVersionGuard(computeContentVersion("stale")) }), VersionGuardConflictError);
  await assert.rejects(f.store.insertHeading("note.md", { ...child, ifMatch: version,
    ifMatchGuard: getVersionGuard(version) }), ConflictingVersionPreconditionsError);
  assert.equal(writes, 0);
  assert.equal(publishes, 0);
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("guarded insertion preserves BOM, CRLF and unrelated bytes through the atomic publication path", async t => {
  const events: string[] = [];
  const f = await fixture(t, { ...nativeMutationIO,
    writeFile: async (handle, bytes) => { events.push("write"); await nativeMutationIO.writeFile(handle, bytes); },
    syncFile: async handle => { events.push("sync"); await nativeMutationIO.syncFile(handle); },
    rename: async (from, to) => {
      events.push("publish");
      assert.equal(path.dirname(from), path.dirname(to));
      assert.match(path.basename(from), /^\.obsidian-mcp-.*\.tmp$/u);
      await nativeMutationIO.rename(from, to);
    },
  });
  const prefix = "\uFEFF---\r\nkeep: 'quoted' # retained\r\n---\r\n# Root\r\nintro ^intro\r\n## Existing\r\nkeep body ^existing\r\n";
  const suffix = "# Outside\r\nstay\r\n";
  const source = prefix + suffix;
  const file = path.join(f.vault, "note.md");
  await writeFile(file, source);
  const body = "中文正文 ^new\r\n\r\n# Child\r\n子节正文 ^child\r\n\r\n## Grandchild\r\n孙节正文\r\n\r\n```md\r\n# 原样示例\r\n```\r\n\r\n- 原样列表\r\n- 第二项";
  const result = await f.store.insertHeading("note.md", { ...child, body,
    ifMatchGuard: getVersionGuard(computeContentVersion(source)) });
  const saved = await readFile(file, "utf8");
  assert.ok(saved.startsWith(prefix));
  assert.ok(saved.endsWith(suffix));
  assert.ok(saved.includes("## Inserted\r\n"));
  assert.ok(saved.includes("中文正文 ^new\r\n\r\n### Child\r\n子节正文 ^child\r\n\r\n#### Grandchild\r\n孙节正文\r\n\r\n```md\r\n# 原样示例\r\n```\r\n\r\n- 原样列表\r\n- 第二项"));
  assert.doesNotMatch(saved, /(?<!\r)\n/u);
  assert.deepEqual(headings(saved), { Root: { Existing: {}, Inserted: { Child: { Grandchild: {} } } }, Outside: {} });
  assert.deepEqual(projectMap(buildModel(withoutBom(saved))).blocks, ["intro", "existing", "new", "child"]);
  assert.equal(result.message, "OK");
  assert.equal(result.created, false);
  assert.equal(result.beforeSizeBytes, Buffer.byteLength(source));
  assert.equal(result.sizeBytes, Buffer.byteLength(saved));
  assert.equal(result.version, computeContentVersion(saved));
  assert.equal(result.versionGuard, getVersionGuard(result.version));
  assert.deepEqual(result.headingPath, insertedPath(saved));
  assert.equal(result.headingLevel, 2);
  assert.deepEqual(events, ["write", "sync", "publish"]);
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("same-version insertions serialize across stores and publish exactly one section", async t => {
  let writes = 0; let publishes = 0;
  const io = { ...nativeMutationIO,
    writeFile: async (handle: Parameters<MutationIO["writeFile"]>[0], bytes: Uint8Array) => {
      writes++; await nativeMutationIO.writeFile(handle, bytes);
    },
    rename: async (from: string, to: string) => { publishes++; await nativeMutationIO.rename(from, to); },
  };
  const f = await fixture(t, io);
  const second = await VaultMutationStore.create(f.sandbox, { io });
  const source = "# Root\nbody\n";
  const file = path.join(f.vault, "note.md");
  await writeFile(file, source);
  const precondition = { ifMatch: computeContentVersion(source) };
  const results = await Promise.allSettled([
    f.store.insertHeading("note.md", { ...child, title: "First", ...precondition }),
    second.insertHeading("note.md", { ...child, title: "Second", ...precondition }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.ok(results.some(result => result.status === "rejected" && result.reason instanceof VersionConflictError));
  assert.equal(writes, 1);
  assert.equal(publishes, 1);
  const saved = await readFile(file, "utf8");
  const children = Object.keys(headings(saved)["Root"]!);
  assert.equal(children.length, 1);
  assert.ok(children[0] === "First" || children[0] === "Second");
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});
