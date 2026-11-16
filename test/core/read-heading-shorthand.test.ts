import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { TargetNotFoundError, type ReadScope } from "markdown-patch";
import { VaultPathSandbox, computeContentVersion, getVaultDocumentMap, readVaultDocument } from "../../src/core/index.js";
import type { VaultDocumentReader } from "../../src/core/document/get-vault-document-map.js";
import { readVaultNote } from "../../src/core/document/read-vault-note.js";
import { VaultSemanticError } from "../../src/core/document/note-json.js";
import { createHeadingAddressResolver } from "../../src/core/parser/heading-addresses.js";
import { buildVaultMarkdownModel } from "../../src/core/parser/structured-markdown.js";
import { getVersionGuard } from "../../src/core/version/content-version.js";

async function fixture(t: TestContext, source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-heading-read-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(vault, "note.md"), source);
  const sandbox = await VaultPathSandbox.create(vault);
  const reader: VaultDocumentReader = (input, options) => readVaultDocument(sandbox, input, options);
  return reader;
}

async function heading(reader: VaultDocumentReader, target: readonly string[] | string, scope: ReadScope = "content") {
  const result = await readVaultNote(reader, "note.md", { targetType: "heading", target, scope });
  assert.ok("result" in result);
  return result;
}

test("unique nested labels retain relative scopes and the same BOM/CRLF exact-byte version", async t => {
  const label = "叶子 🌱";
  const source = "\uFEFF---\r\nstatus: ready\r\n---\r\n# Root\r\nintro\r\n" +
    `### ${label}\r\n正文 ^id\r\n##### Nested\r\nchild\r\n`;
  const reader = await fixture(t, source);
  for (const scope of ["content", "marker", "markerAndContent"] as const) {
    const shorthand = await heading(reader, label, scope);
    assert.deepEqual(shorthand, await heading(reader, ["Root", label], scope));
    assert.equal(shorthand.version, computeContentVersion(source));
    assert.equal(shorthand.versionGuard, getVersionGuard(computeContentVersion(source)));
  }
  assert.equal((await heading(reader, label)).result, "正文 ^id\r\n## Nested\r\nchild\r\n");
  assert.match(String((await heading(reader, label, "markerAndContent")).result), /^## 叶子 🌱\r\n/u);
});

test("array and encoded-array paths stay exact while top-level and nested same labels are ambiguous", async t => {
  const source = "# Same\ntop\n# Parent\n## Same\nnested\n";
  const reader = await fixture(t, source);
  assert.equal((await heading(reader, ["Same"])).result, "top\n");
  assert.equal((await heading(reader, ["Parent", "Same"])).result, "nested\n");
  assert.deepEqual(await heading(reader, '["Parent","Same"]'), await heading(reader, ["Parent", "Same"]));
  await assert.rejects(heading(reader, "Same"), error => {
    assert.ok(error instanceof VaultSemanticError);
    assert.equal(error.code, "ambiguous_heading");
    assert.deepEqual(error.details, { candidates: [["Same"], ["Parent", "Same"]], total: 2, truncated: false });
    return true;
  });
  await assert.rejects(heading(reader, ["missing"]), TargetNotFoundError);
  assert.equal((await heading(reader, [])).result, source);
  assert.deepEqual(await heading(reader, "[]"), await heading(reader, []));
  await assert.rejects(heading(reader, [], "marker"), TargetNotFoundError);
});

test("duplicate sibling and ancestor map keys remain usable with numeric headings in source order", async t => {
  const source = "# 10\n## Same\nfirst\n## Same\nsecond\n### Only\nunique\n" +
    "# 2\n## Same\nthird\n# 10\n## 10\nten child\n## 2\ntwo child\n";
  const reader = await fixture(t, source);
  const map = await getVaultDocumentMap(reader, "note.md");
  const secondSame = Object.keys(map.headings["10"]!).find(key => key !== "Same")!;
  const secondTen = Object.keys(map.headings).find(key => key !== "10" && key !== "2")!;
  await assert.rejects(heading(reader, "Same"), error => {
    assert.ok(error instanceof VaultSemanticError);
    assert.deepEqual(error.details, { candidates: [["10", "Same"], ["10", secondSame], ["2", "Same"]], total: 3, truncated: false });
    return true;
  });
  assert.deepEqual(await heading(reader, "Only"), await heading(reader, ["10", secondSame, "Only"]));
  assert.equal((await heading(reader, ["10", secondSame], "marker")).result, "Same");
  await assert.rejects(heading(reader, secondSame), TargetNotFoundError);

  const model = buildVaultMarkdownModel(source);
  const addresses = createHeadingAddressResolver(model);
  assert.equal(Object.keys(map.headings)[0], "2");
  assert.equal(addresses.resolve(["10"]), model.root.children[0]);
  assert.equal(addresses.resolve(["2"]), model.root.children[1]);
  assert.equal(addresses.resolve([secondTen, "10"]), model.root.children[2]!.children[0]);
  assert.equal(addresses.resolve([secondTen, "2"]), model.root.children[2]!.children[1]);
  assert.deepEqual(addresses.pathOf(model.root.children[2]!.children[0]!), [secondTen, "10"]);
  assert.equal(addresses.resolve(null), model.root);
  assert.equal(addresses.resolve([]), model.root);
  assert.equal(addresses.resolve(["Same"]), undefined);
});

test("ambiguity candidates have an explicit total and a bounded recoverable path list", async t => {
  const reader = await fixture(t, Array.from({ length: 20 }, (_, index) => `# Parent ${index}\n## Common\nbody ${index}\n`).join(""));
  await assert.rejects(heading(reader, "Common"), error => {
    assert.ok(error instanceof VaultSemanticError);
    assert.deepEqual(error.details, {
      candidates: Array.from({ length: 16 }, (_, index) => [`Parent ${index}`, "Common"]), total: 20, truncated: true,
    });
    return true;
  });
  assert.equal((await heading(reader, ["Parent 15", "Common"])).result, "body 15\n");
});

test("only encoded string arrays keep path meaning; other strings match raw labels without normalization", async t => {
  const labels = ["null", "true", "{}", "[1]", '"quoted"', '["literal"]', "[]", "Leaf", ""];
  const reader = await fixture(t, labels.map(label => `# ${label}\nbody\n`).join(""));
  for (const label of ["null", "true", "{}", "[1]", '"quoted"', "Leaf", ""]) {
    assert.equal((await heading(reader, label, "marker")).result, label);
  }
  assert.equal((await heading(reader, ' [ "Leaf" ] ', "marker")).result, "Leaf");
  assert.equal((await heading(reader, ['["literal"]'], "marker")).result, '["literal"]');
  assert.equal((await heading(reader, ["[]"], "marker")).result, "[]");
  for (const target of [" Leaf ", "leaf", "  ", '["literal"]']) await assert.rejects(heading(reader, target), TargetNotFoundError);
});

test("the shared parser finds setext and H6 headings while fenced and HTML pseudo-headings stay opaque", async t => {
  const reader = await fixture(t, "# Root\n\n```md\n## Shared\n## FenceOnly\n```\n\n" +
    "<div>\n## Shared\n## HtmlOnly\n</div>\n\nShared\n------\nreal setext body\n\n" +
    "###### Deep\ndeep body\n\n# **Bold**\nformatted raw body\n");
  assert.equal((await heading(reader, "Shared", "marker")).result, "Shared");
  assert.deepEqual(await heading(reader, "Shared"), await heading(reader, ["Root", "Shared"]));
  assert.equal((await heading(reader, "Deep")).result, "deep body\n");
  assert.equal((await heading(reader, "**Bold**", "marker")).result, "**Bold**");
  for (const target of ["FenceOnly", "HtmlOnly", "Bold"]) await assert.rejects(heading(reader, target), TargetNotFoundError);
});
