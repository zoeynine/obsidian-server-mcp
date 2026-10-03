import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryReferences } from "../../src/core/reference/query-references.js";
import { ReferenceQueryError, type ReferenceQueryInput } from "../../src/core/reference/types.js";
import { computeContentVersion, readVaultDocument, VaultDocumentTooLargeError, VaultPathError } from "../../src/core/index.js";
import { binaryFixture } from "../helpers/binary-fixture.js";

const root = { directory: "", recursive: true };
async function fixture(t: TestContext, files: Record<string, string | Buffer>) {
  const f = await binaryFixture(t);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(f.vault, name)), { recursive: true });
    await writeFile(path.join(f.vault, name), content);
  }
  const read = (p: string, o?: { maxBytes?: number }) => readVaultDocument(f.sandbox, p, o);
  return { ...f, read, query: (input: Partial<ReferenceQueryInput> = {}) =>
    queryReferences(f.sandbox, read, { scope: root, target: { path: "Note.md" }, ...input }) };
}
const code = (wanted: string) => (error: unknown) => error instanceof ReferenceQueryError && error.code === wanted;

test("a reused filename inventory cannot turn a missing or non-directory source scope into empty success", async t => {
  const f = await fixture(t, { "Note.md": "# Note" });
  for (const directory of ["missing", "Note.md"]) await assert.rejects(f.query({
    scope: { directory, recursive: true }, resolutionScope: root,
  }), code("scan_failed"));
});

test("bounded source scan respects nonrecursive scope and does not read other source bodies or attachments", async t => {
  const f = await fixture(t, { "docs/Note.md": "# Target\n", "refs/a.md": "[label](../docs/Note.md)",
    "refs/nested/b.md": "[[docs/Note]]", "outside.md": "---\nunclosed", "image.png": Buffer.from([0xff]) });
  const reads: string[] = [];
  const result = await queryReferences(f.sandbox, async (p, o) => { reads.push(p); return f.read(p, o); }, {
    scope: { directory: "refs", recursive: false }, resolutionScope: root, target: { path: "docs/Note.md" },
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0]!.source.path, "refs/a.md");
  assert.deepEqual(reads, ["docs/Note.md", "refs/a.md", "docs/Note.md"]);
  assert.equal(result.coverage.incomingOutsideScope, "unknown");
  assert.equal(result.coverage.atomicSnapshot, false);
  const recursive = await f.query({ scope: { directory: "refs", recursive: true }, target: { path: "docs/Note.md" } });
  assert.equal(recursive.matches.length, 2);
});

test("short filenames need a complete candidate inventory; duplicates remain ambiguous", async t => {
  const f = await fixture(t, { "folder/Note.md": "# Note", "refs/a.md": "[[Note|alias]]" });
  const options = { scope: { directory: "refs", recursive: false }, target: { path: "folder/Note.md" } };
  const partial = await f.query(options);
  assert.equal(partial.matches.length, 0);
  assert.equal(partial.uncertain[0]!.status, "unknown");
  assert.deepEqual(partial.uncertain[0]!.candidates, ["folder/Note.md"]);
  assert.equal((await f.query({ ...options, resolutionScope: root })).matches.length, 1);
  await mkdir(path.join(f.vault, "other"));
  await writeFile(path.join(f.vault, "other/Note.md"), "# Other");
  const duplicate = await f.query({ ...options, resolutionScope: root });
  assert.equal(duplicate.uncertain[0]!.status, "ambiguous");
  assert.deepEqual(duplicate.uncertain[0]!.candidates, ["folder/Note.md", "other/Note.md"]);
});

test("file/heading/block references, display aliases and embeds retain exact source versions", async t => {
  const body = "# Parent\n## Child\nbody ^id\n\n# Else\n## Child\nother ^dup\n\nagain ^dup\n";
  const links = "[[Note|display]] ![[Note#Parent#Child]] [[Note#Child]] [[Note#^id]] [[Note#^dup]] [[Note#Missing]]";
  const f = await fixture(t, { "Note.md": body, "refs.md": links });
  const result = await f.query();
  assert.equal(result.target.version, computeContentVersion(body));
  assert.equal(result.matches.length, 3);
  assert.deepEqual(result.uncertain.map(item => item.status), ["ambiguous", "ambiguous", "unresolved"]);
  for (const item of [...result.matches, ...result.uncertain]) {
    assert.equal(item.source.version, computeContentVersion(links));
    assert.equal(links.slice(item.start, item.end), item.raw);
  }
  const heading = await f.query({ target: { path: "Note.md", heading: ["Parent", "Child"] } });
  assert.deepEqual(heading.matches.map(item => item.raw), ["![[Note#Parent#Child]]"]);
  assert.equal((await f.query({ target: { path: "Note.md", block: "id" } })).matches[0]!.raw, "[[Note#^id]]");
  const ambiguous = await f.query({ target: { path: "Note.md", heading: ["Child"] } });
  assert.equal(ambiguous.target.status, "ambiguous");
  assert.equal(ambiguous.matches.length, 0);
});

test("references support same-note and parent-relative paths, URI escaping and attachment existence only", async t => {
  const f = await fixture(t, { "文 件😀.md": "# 标题\n[[#标题]]", "sub/refs.md": "[中文](../文%20件%F0%9F%98%80.md#%E6%A0%87%E9%A2%98) ![[a.pdf]] ![[a.pdf#page=3]]", "a.pdf": Buffer.from([0xff, 0, 0xfe]) });
  const note = await f.query({ target: { path: "文 件😀.md" } });
  assert.equal(note.matches.length, 2);
  const pdf = await f.query({ target: { path: "a.pdf" } });
  assert.equal(pdf.target.fileExists, true);
  assert.equal(pdf.matches.length, 1);
  assert.equal(pdf.matches[0]!.embed, true);
  assert.equal(pdf.uncertain.find(item => item.href.includes("page="))!.status, "unsupported");
  assert.deepEqual(await readFile(path.join(f.vault, "a.pdf")), Buffer.from([0xff, 0, 0xfe]));
});

test("missing files, unsupported syntax, invalid percent escapes and out-of-scope links stay explicit", async t => {
  const f = await fixture(t, { "refs/a.md": "[[./missing]] [[bad [nested](other.md)]] [bad](%GG.md) [[other/File]] [[Alias]] [external](https://example.invalid)", "Other.md": "---\naliases: [Alias]\n---\n" });
  const result = await f.query({ scope: { directory: "refs", recursive: false }, target: { path: "refs/missing.md" } });
  assert.equal(result.target.fileExists, false);
  assert.equal(result.matches.length, 0);
  assert.ok(result.uncertain.some(item => item.status === "unresolved"));
  assert.ok(result.uncertain.some(item => item.status === "unsupported"));
  assert.ok(result.uncertain.some(item => item.reason === "outside_resolution_scope"));
  assert.ok(!result.uncertain.some(item => item.href.startsWith("https:")));
  const full = await f.query({ target: { path: "Other.md" } });
  assert.equal(full.uncertain.find(item => item.href === "Alias")!.status, "unresolved");
});

test("query and resolved link paths keep traversal, protected-path and symlink safeguards", async t => {
  const f = await fixture(t, { "Note.md": "# Note", "refs.md": "[escape](../outside.md) [encoded](%2E%2E/outside.md) [[.obsidian/private]] [[linked/file]]" });
  const outside = path.join(f.root, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "file.md"), "private");
  await symlink(outside, path.join(f.vault, "linked"), "junction");
  const result = await f.query();
  assert.equal(result.matches.length, 0);
  assert.ok(result.uncertain.every(item => item.status === "unsupported"));
  for (const invalid of ["../outside.md", ".obsidian/private", "linked/file.md"]) {
    await assert.rejects(f.query({ target: { path: invalid } }), error => error instanceof VaultPathError);
  }
  await assert.rejects(f.query({ scope: { directory: "linked", recursive: true } }), error => error instanceof VaultPathError);
});

test("query budgets fail rather than truncate, including response envelope and final target recheck", async t => {
  const f = await fixture(t, { "Note.md": "# Note", "refs.md": "[[Note]] [[Note]]" });
  for (const key of ["maxEntries", "maxFiles", "maxResults", "maxOutputBytes"] as const) {
    await assert.rejects(f.query({ [key]: 1 }), code("budget_exceeded"));
  }
  await assert.rejects(f.query({ maxFileBytes: 1 }), error => error instanceof VaultDocumentTooLargeError);
  const accepted = await f.query();
  assert.equal((await f.query({ maxTotalBytes: accepted.coverage.bytesRead })).matches.length, 2);
  await assert.rejects(f.query({ maxTotalBytes: accepted.coverage.bytesRead - 1 }));
  for (const value of [-1, 0, NaN, Infinity, 10_001]) await assert.rejects(f.query({ maxResults: value }), code("invalid_input"));
});

test("source failure or mismatched reader paths cannot masquerade as an empty complete query", async t => {
  const f = await fixture(t, { "Note.md": "# Note", "refs.md": "[[Note]]" });
  await assert.rejects(queryReferences(f.sandbox, async (p, o) => {
    if (p === "refs.md") throw new Error("private host path should not escape transport");
    return f.read(p, o);
  }, { scope: root, target: { path: "Note.md" } }));
  await assert.rejects(queryReferences(f.sandbox, async (p, o) => {
    const doc = await f.read(p, o); return p === "refs.md" ? { ...doc, path: f.sandbox.parse("changed.md") } : doc;
  }, { scope: root, target: { path: "Note.md" } }), code("scan_failed"));
});

test("encoded fragment delimiters and unsafe bare names cannot resolve to a different supported anchor", async t => {
  const f = await fixture(t, { "Note.md": "# A\n## B\n", "ref.md": "[literal hash](Note.md#A%23B) [[CON]] [[.secret]]" });
  const result = await f.query();
  assert.equal(result.matches.length, 0);
  assert.ok(result.uncertain.every(item => item.status === "unsupported"));
});

test("opaque Markdown syntax cannot confirm a different filename or a stripped heading", async t => {
  const f = await fixture(t, { "Note      .md": "# Note", "Note.md": "# A $x$\n",
    "refs.md": "[opaque](<Note$hide$.md>) [[Note#A]]" });
  const file = await f.query({ target: { path: "Note      .md" } });
  assert.equal(file.matches.length, 0);
  assert.equal(file.uncertain.find(link => link.raw.startsWith("[opaque]"))!.reason, "opaque_link_syntax");
  const heading = await f.query({ target: { path: "Note.md", heading: ["A"] } });
  assert.equal(heading.target.status, "unsupported");
  assert.equal(heading.matches.length, 0);
  assert.equal(heading.uncertain.find(link => link.raw === "[[Note#A]]")!.status, "unsupported");
  await writeFile(path.join(f.vault, "Note.md"), "# A\n# A %%hidden%%\n");
  const possibleDuplicate = await f.query({ target: { path: "Note.md", heading: ["A"] } });
  assert.equal(possibleDuplicate.target.status, "unsupported");
  assert.equal(possibleDuplicate.matches.length, 0);
});

test("namespace and target changes during a query fail explicitly without a mixed resolution result", async t => {
  const f = await fixture(t, { "Note.md": "# Original", "refs.md": "[[Note#Original]]" });
  let changed = false;
  await assert.rejects(queryReferences(f.sandbox, async (p, o) => {
    const doc = await f.read(p, o);
    if (p === "refs.md" && !changed) { changed = true; await writeFile(path.join(f.vault, "Note.md"), "# Changed"); }
    return doc;
  }, { scope: root, target: { path: "Note.md" } }), code("changed_during_query"));
  changed = false;
  await assert.rejects(queryReferences(f.sandbox, async (p, o) => {
    const doc = await f.read(p, o);
    if (p === "refs.md" && !changed) { changed = true; await writeFile(path.join(f.vault, "new.md"), "new"); }
    return doc;
  }, { scope: root, target: { path: "Note.md" } }), code("changed_during_query"));
  let targetReads = 0;
  await assert.rejects(queryReferences(f.sandbox, async (p, o) => {
    const doc = await f.read(p, o);
    if (p === "Note.md" && ++targetReads === 2) await writeFile(path.join(f.vault, "late.md"), "late namespace change");
    return doc;
  }, { scope: root, target: { path: "Note.md" } }), code("changed_during_query"));
});
