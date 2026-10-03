import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { patch as upstreamPatch } from "markdown-patch";
import { VaultPathSandbox, readVaultDocument, getVaultDocumentMap, listVaultFiles, listVaultTags, searchVaultQuery, computeContentVersion } from "../../src/core/index.js";
import { readVaultNote } from "../../src/core/document/read-vault-note.js";
import { parseFrontmatter, requireJson, VaultSemanticError, withoutBom } from "../../src/core/document/note-json.js";
import { prepareVaultPatch } from "../../src/core/patch/prepare-vault-patch.js";
import { validateQuery } from "../../src/core/search/json-logic-query.js";

async function fixture(t: TestContext, protectedPaths: string[] = []) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-parity-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = await VaultPathSandbox.create(vault, { protectedPaths });
  const reader = (p: string, o?: {maxBytes?: number}) => readVaultDocument(sandbox, p, o);
  return { vault, sandbox, reader };
}

test("read and map use pinned duplicate heading/block addresses and all three scopes", async t => {
  const f = await fixture(t);
  const source = "\uFEFF---\r\nstatus: done\r\ntags: [one, two]\r\n---\r\n# Parent\r\nintro\r\n## Log\r\nfirst ^same\r\n\r\n## Log\r\nsecond ^same\r\n";
  await writeFile(path.join(f.vault, "note.md"), source);
  const map = await getVaultDocumentMap(f.reader, "note.md");
  const keys = Object.keys(map.headings["Parent"]!);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], "Log");
  assert.notEqual(keys[1], "Log");
  assert.deepEqual(map.frontmatterFields, ["status", "tags"]);
  assert.equal(new Set(map.blocks).size, 2);
  for (const [targetType, target, scope, expected] of [
    ["heading", ["Parent", keys[1]!], "content", "second ^same\r\n"],
    ["heading", ["Parent", keys[1]!], "marker", "Log"],
    ["heading", ["Parent", keys[1]!], "markerAndContent", "# Log\r\nsecond ^same\r\n"],
    ["block", map.blocks[1]!, "content", "second"],
    ["block", map.blocks[1]!, "marker", "same"],
    ["block", map.blocks[1]!, "markerAndContent", "second ^same"],
    ["frontmatter", "tags", "content", ["one", "two"]],
    ["frontmatter", "tags", "marker", "tags"],
    ["frontmatter", "tags", "markerAndContent", {tags: ["one", "two"]}],
  ] as const) {
    const result = await readVaultNote(f.reader, "note.md", { targetType, target, scope });
    assert.ok("result" in result);
    assert.deepEqual(result.result, expected);
    assert.equal(result.version, computeContentVersion(source));
    assert.equal("content" in result, false);
  }
  const note = await readVaultNote(f.reader, "note.md");
  assert.ok("content" in note);
  assert.equal(note.content, source);
  assert.deepEqual(note.frontmatter, {status: "done", tags: ["one", "two"]});
  assert.equal(note.stat.size, Buffer.byteLength(source));
  assert.equal("backlinks" in note, false);
  await assert.rejects(readVaultNote(f.reader, "note.md", {targetType: "heading", target: "Log"}), /array/u);
  await assert.rejects(readVaultNote(f.reader, "missing.md", {scope: "content"}), VaultSemanticError);
});

test("generic frontmatter patch follows the operation/scope table and preserves unrelated bytes", async t => {
  const f = await fixture(t);
  const body = "# Body\r\n[[Unknown|Alias]] %% secret %%\r\n^id\r\n";
  const source = "\uFEFF---\r\n# untouched comment\r\nkeep: 'exact quote' # exact comment\r\nlist: [one, two]\r\nword: abc\r\nobj: {a: 1, b: 2}\r\nempty:\r\n---\r\n" + body;
  await writeFile(path.join(f.vault, "note.md"), source);
  const document = await f.reader("note.md");
  const instructions = [
    {targetType: "frontmatter", target: "list", operation: "replace", value: ["new"]},
    {targetType: "frontmatter", target: "list", operation: "append", value: ["three"]},
    {targetType: "frontmatter", target: "list", operation: "prepend", value: ["zero"]},
    {targetType: "frontmatter", target: "word", operation: "append", value: "def"},
    {targetType: "frontmatter", target: "word", operation: "prepend", value: "before"},
    {targetType: "frontmatter", target: "word", operation: "replace", scope: "markerAndContent", value: 12},
    {targetType: "frontmatter", target: "obj", operation: "prepend", value: {a: 7, c: 3}},
    {targetType: "frontmatter", target: "obj", operation: "append", value: {a: 7, c: 3}},
    {targetType: "frontmatter", target: "empty", operation: "replace", value: [1, 2]},
    {targetType: "frontmatter", target: "list", operation: "replace", scope: "marker", content: "new name"},
    {targetType: "frontmatter", target: "list", operation: "delete", scope: "content"},
    {targetType: "frontmatter", target: "list", operation: "delete", scope: "markerAndContent"},
    {targetType: "frontmatter", target: "list", operation: "append", scope: "markerAndContent", value: {newKey: true}},
    {targetType: "frontmatter", target: "list", operation: "prepend", scope: "markerAndContent", value: {newKey: true}},
    {targetType: "frontmatter", target: "missing", operation: "append", createTargetIfMissing: true, value: ["tag"]},
  ] as const;
  for (const instruction of instructions) {
    const result = prepareVaultPatch(document, {...instruction, ifMatch: document.version});
    const expected = upstreamPatch(withoutBom(source), instruction);
    assert.deepEqual(parseFrontmatter(withoutBom(result.document)).value, parseFrontmatter(expected.document).value);
    assert.ok(result.document.startsWith("\uFEFF---\r\n# untouched comment\r\nkeep: 'exact quote' # exact comment\r\n"));
    assert.ok(result.document.endsWith(body));
  }
  const noOp = prepareVaultPatch(document, {targetType: "frontmatter", target: "list", operation: "replace", value: ["one", "two"], ifMatch: document.version});
  assert.equal(noOp.document, source);
  assert.throws(() => prepareVaultPatch(document, {...instructions[0], ifMatch: computeContentVersion("stale")}), /ifMatch/u);
  assert.throws(() => prepareVaultPatch(document, instructions[0]), /requires ifMatch/u);
  assert.throws(() => prepareVaultPatch(document, {targetType: "frontmatter", target: "list", operation: "replace", content: "wrong", ifMatch: document.version}), /contract/u);
  assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), source); // Pure preparation only.
  for (const instruction of [
    {targetType: "frontmatter", target: "word", operation: "replace", scope: "marker", content: "list"},
    {targetType: "frontmatter", target: "word", operation: "append", scope: "markerAndContent", value: {list: []}},
    {targetType: "frontmatter", target: "missing", operation: "replace", value: "x"},
    {targetType: "frontmatter", target: "list", operation: "append", value: "incompatible"},
  ]) assert.throws(() => prepareVaultPatch(document, {...instruction, ifMatch: document.version}));
  const repeat = prepareVaultPatch(document, {targetType: "frontmatter", target: "word", operation: "append", value: "abc", rejectIfContentPreexists: true, ifMatch: document.version});
  assert.equal(parseFrontmatter(withoutBom(repeat.document)).value["word"], "abcabc");
  const noProperties = {...document, content: "\uFEFF# Body\r\n", version: computeContentVersion("\uFEFF# Body\r\n")};
  const added = prepareVaultPatch(noProperties, {targetType: "frontmatter", target: "status", operation: "replace", value: "new", createTargetIfMissing: true, ifMatch: noProperties.version});
  assert.deepEqual(parseFrontmatter(withoutBom(added.document)).value, {status: "new"});
  assert.ok(added.document.endsWith("# Body\r\n"));
});

test("search preserves JsonLogic coercion, value results, collections, missing values and pinned glob semantics", async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.vault, "journal"));
  await writeFile(path.join(f.vault, "journal/a.md"), "---\nstatus: done\npriority: 2\nitems: [1, 2, 3]\ntags: [project, work]\n---\n# Heading\ntext");
  const cases: [unknown, unknown][] = [
    [{"==": [{var: "frontmatter.priority"}, "2"]}, true],
    [{var: "frontmatter.items"}, [1, 2, 3]],
    [{if: [{"==": [{var: "frontmatter.status"}, "done"]}, {var: "frontmatter"}, false]}, {status: "done", priority: 2, items: [1,2,3], tags: ["project", "work"]}],
    [{and: [{in: ["work", {var: "tags"}]}, {var: "path"}]}, "journal/a.md"],
    [{var: ["frontmatter.absent", "fallback"]}, "fallback"],
    [{map: [{var: "frontmatter.items"}, {"*": [{var: ""}, 2]}]}, [2,4,6]],
    [{reduce: [{var: "frontmatter.items"}, {"+": [{var: "accumulator"}, {var: "current"}]}, 0]}, 6],
    [{glob: ["*.md", {var: "path"}]}, true], // Pinned upstream * includes /.
    [{regexp: ["^journal/", {var: "path"}]}, true],
  ];
  for (const [query, expected] of cases) {
    const results = await searchVaultQuery(f.sandbox, f.reader, query);
    assert.equal(results.length, 1, JSON.stringify(query));
    assert.deepEqual(results[0]!.result, expected);
  }
  assert.deepEqual(await searchVaultQuery(f.sandbox, f.reader, {var: "frontmatter.absent"}), []);
  assert.deepEqual(await searchVaultQuery(f.sandbox, f.reader, {if: [true, {}, false]}), []);
  for (const query of [{log: "bad"}, {var: "backlinks"}, {var: "frontmatter.__proto__.polluted"}]) {
    assert.throws(() => validateQuery(query));
  }
  await assert.rejects(searchVaultQuery(f.sandbox, f.reader, {var: {cat: ["back", "links"]}}), /invalid_var/u);
  await writeFile(path.join(f.vault, "journal/a.md"), "---\nitems:\n  - links: own property\n---\nbody");
  const scoped = await searchVaultQuery(f.sandbox, f.reader, {map: [{var: "frontmatter.items"}, {var: "links"}]});
  assert.deepEqual(scoped[0]?.result, ["own property"]);
});

test("query resource bounds reject oversized/deep/non-JSON input and stop pathological regexp off-thread", async t => {
  const f = await fixture(t);
  for (const query of [{var: "x".repeat(1025)}, {a: "x".repeat(17000), b: 1}, {"==": [NaN, 1]}]) assert.throws(() => validateQuery(query));
  let deep: unknown = {var: "path"};
  for (let n = 0; n < 10; n++) deep = {"!": deep};
  assert.throws(() => validateQuery(deep));
  await writeFile(path.join(f.vault, "note.md"), "a".repeat(5000) + "!");
  await assert.rejects(searchVaultQuery(f.sandbox, f.reader, {regexp: ["^(a+)+$", {var: "content"}]}), /evaluation_limit/u);
  assert.equal((await searchVaultQuery(f.sandbox, f.reader, {var: "path"})).length, 1);
});

test("one shared policy protects direct reads, maps, listing, query and tag traversal", async t => {
  const f = await fixture(t, ["InternalState"]);
  for (const directory of [".obsidian", ".git", "InternalState"]) {
    await mkdir(path.join(f.vault, directory));
    await writeFile(path.join(f.vault, directory, "secret.md"), Buffer.from([0xff]));
    await assert.rejects(f.reader(directory + "/secret.md"), /protected/u);
    await assert.rejects(getVaultDocumentMap(f.reader, directory + "/secret.md"), /protected/u);
  }
  await writeFile(path.join(f.vault, "visible.md"), "#tag");
  assert.deepEqual(await listVaultFiles(f.sandbox), {files: ["visible.md"]});
  await mkdir(path.join(f.vault, "folder"));
  assert.deepEqual(await listVaultFiles(f.sandbox, "folder/"), {files: []});
  await assert.rejects(listVaultFiles(f.sandbox, "/"));
  await assert.rejects(listVaultFiles(f.sandbox, "folder/../"));
  assert.deepEqual((await searchVaultQuery(f.sandbox, f.reader, {var: "path"})).map(x => x.filename), ["visible.md"]);
  assert.deepEqual(await listVaultTags(f.sandbox, f.reader), {tags: [{name: "tag", count: 1}]});
  for (const p of ["../outside", "/tmp/x", "C:/x", "internalstate/other.md", "x/.trash/file.md"]) assert.throws(() => f.sandbox.parse(p));
});

test("text paths refuse binary extensions, malformed UTF-8 and NUL while allowing SVG source", async t => {
  const f = await fixture(t);
  for (const extension of ["png", "svgz", "pdf", "epub", "docx", "zip", "bz2", "xz", "mp4", "ttf", "wasm"]) {
    await writeFile(path.join(f.vault, "attachment." + extension), "ascii bytes");
    await assert.rejects(f.reader("attachment." + extension), /binary_extension/u);
  }
  await writeFile(path.join(f.vault, "with-nul.md"), "valid\0text");
  await assert.rejects(f.reader("with-nul.md"), /nul_byte/u);
  await writeFile(path.join(f.vault, "bad.md"), Buffer.from([0xc0, 0xaf]));
  await assert.rejects(f.reader("bad.md"), /UTF-8/u);
  await writeFile(path.join(f.vault, "icon.svg"), "<svg/>\n");
  assert.equal((await f.reader("icon.svg")).content, "<svg/>\n");
});

test("JSON and YAML safety guards refuse lossy containers, aliases and nested complex keys", () => {
  const disguisedSparse = Object.assign([1, ,], {extra: 2});
  assert.throws(() => requireJson(disguisedSparse), /sparse/u);
  assert.throws(() => requireJson(Object.defineProperty({}, "value", {enumerable: true, get() { throw new Error("must not run"); }})), /accessors/u);
  for (const yaml of ["key: &anchor 1", "key: *anchor", "key: !!str text", "key: 1\nkey: 2", "key: { [a, b]: 1 }", "key: { 1: numeric }", "key: .nan"]) {
    assert.throws(() => parseFrontmatter("---\n" + yaml + "\n---\n"), VaultSemanticError, yaml);
  }
});
