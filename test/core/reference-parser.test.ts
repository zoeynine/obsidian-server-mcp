import assert from "node:assert/strict";
import test from "node:test";
import { parseReferences } from "../../src/core/reference/parse-references.js";
import { ReferenceParser } from "../../src/core/reference/reference-parser.js";
import { ReferenceQueryError } from "../../src/core/reference/types.js";

test("reference parser preserves exact BOM/CRLF/Chinese/emoji source spans and CommonMark escapes", () => {
  const source = '\uFEFF---\r\nlinks: "[[hidden]]"\r\n---\r\n# 中文😀\r\n😀 [[目标#标题|显示]] ![[附件.png|100]] [escaped](a\\(b\\).md) [中文](文%20件.md)\r\n[text][ref]\r\n\r\n[ref]: 目标.md "title"\r\n';
  const result = parseReferences(source);
  assert.deepEqual(result.links.map(link => link.href), ["目标#标题", "附件.png", "a(b).md", "文%20件.md", "目标.md"]);
  for (const link of result.links) assert.equal(source.slice(link.start, link.end), link.raw);
  assert.equal(result.links[0]!.line, 5);
  assert.equal(result.links[0]!.column, 4);
  assert.equal(result.links[1]!.embed, true);
  assert.equal(result.links[4]!.raw, "[text][ref]");
});

test("reference parser excludes fenced/indented/nested code, comments, HTML and balanced math", () => {
  const source = [
    "`[[inline]]` and \\[[escaped]]", "", "    [[indented]]", "", "```md", "[[fence]]", "```",
    "> ~~~", "> [[quoted fence]]", "> ~~~", "", "- ```", "  [[list fence]]", "  ```", "",
    "<!-- [[html comment]] -->", "<div>", "[[html block]]", "</div>", "", "%%", "```", "[[comment fence]]", "%%", "",
    "$[[math]]$ $$[[display]]$$", "", "[[visible]] [visible](visible.md)",
  ].join("\n");
  assert.deepEqual(parseReferences(source).links.map(link => link.href), ["visible", "visible.md"]);
});

test("reference parser supports links in lists, quotes, tables, reference images and escaped wiki pipes", () => {
  const source = '- [[one]]\n> [[two]]\n\n| cell |\n| --- |\n| [[three\\|label]] |\n\n![picture][p]\n\n[p]: image.png\n';
  const links = parseReferences(source).links;
  assert.deepEqual(links.map(link => link.href), ["one", "two", "three", "image.png"]);
  assert.equal(links[3]!.embed, true);
});

test("reference parser does not fabricate nested or unclosed wiki destinations", () => {
  const links = parseReferences("[[one|[[two]]]]\n[[unclosed\n[[ok]]").links;
  assert.equal(links[0]!.unsupported, "nested_wikilink_syntax");
  assert.equal(links[1]!.unsupported, "unclosed_wikilink");
  assert.equal(links[2]!.href, "ok");
});

test("opaque regions cannot rewrite Markdown destinations or manufacture plain heading anchors", () => {
  const source = "[one](Note%%hide%%.md) [two](<Note%%hide%%.md>) [three](<Note$hide$.md>)\n" +
    "%% [excluded](Note.md) %%\n$[excluded](Note.md)$\n# A $x$\n## Child\n# B %%hidden%%\n# Plain\n";
  const parsed = parseReferences(source, true);
  assert.deepEqual(parsed.links.map(link => link.href), ["Note%%hide%%.md", "Note%%hide%%.md", "Note$hide$.md"]);
  assert.ok(parsed.links.every(link => link.unsupported === "opaque_link_syntax"));
  assert.deepEqual(parsed.headings.filter(heading => heading.supported).map(heading => heading.path), [["Plain"]]);
});

test("target count includes the final section's blocks and rejects one over the shared limit", () => {
  const blocks = Array.from({ length: 10_000 }, (_, i) => `body ^b${i}`).join("\n\n");
  assert.equal(parseReferences(blocks, true).blocks.length, 10_000);
  for (const source of [blocks + "\n\nbody ^overflow", "# Heading\n" + blocks]) {
    assert.throws(() => parseReferences(source, true), error => error instanceof ReferenceQueryError && error.code === "parse_limit");
  }
});

test("target model retains duplicate heading/block evidence and rejects formatted heading assumptions", () => {
  const model = parseReferences("# Root\n## Same\nbody ^id\n\n## Same\nother ^id\n\n# **Bold**\n# `Code`\n%%\n# Hidden\n%%\n", true);
  assert.equal(model.headings.filter(item => item.path.at(-1) === "Same").length, 2);
  assert.deepEqual(model.blocks, ["id", "id"]);
  assert.equal(model.headings.filter(item => !item.supported).length, 2);
  assert.ok(!model.headings.some(item => item.path.includes("Hidden")));
});

test("parser worker bounds active invocations, fails malformed sources, and releases slots", async () => {
  const parsers = Array.from({ length: 4 }, () => new ReferenceParser());
  try {
    assert.throws(() => new ReferenceParser(), error => error instanceof ReferenceQueryError && error.code === "busy");
    await assert.rejects(parsers[0]!.parse("---\nunclosed"), error => error instanceof ReferenceQueryError && error.code === "parse_failed");
    await assert.rejects(parsers[1]!.parse("[[" + "x".repeat(20_000) + "]]"), error => error instanceof ReferenceQueryError && error.code === "parse_limit");
  } finally { await Promise.all(parsers.map(parser => parser.close())); }
  const recovered = new ReferenceParser();
  try { assert.equal((await recovered.parse("[[ok]]")).links.length, 1); } finally { await recovered.close(); }
});
