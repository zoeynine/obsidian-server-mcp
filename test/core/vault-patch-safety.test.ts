import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { buildModel, projectMap } from "markdown-patch";
import { parseFrontmatter, VaultSemanticError, withoutBom } from "../../src/core/document/note-json.js";
import type { VaultDocumentReadResult } from "../../src/core/file/read-vault-document.js";
import { nativeMutationIO } from "../../src/core/mutation/mutation-io.js";
import { VaultMutationStore } from "../../src/core/mutation/vault-mutations.js";
import { parseVaultRelativePath, VaultPathSandbox } from "../../src/core/path/vault-path.js";
import { prepareVaultPatch } from "../../src/core/patch/prepare-vault-patch.js";
import { computeContentVersion, getVersionGuard, VersionConflictError, VersionGuardConflictError } from "../../src/core/version/content-version.js";

const section = "# A\nintro\n\n## B\nkeep B\n\n## C\nkeep C\n\n# Outside\nstay\n";
const replace = { targetType: "heading", target: ["A"], operation: "replace", content: "new body" };
function document(content: string): VaultDocumentReadResult {
  return { path: parseVaultRelativePath("note.md"), content, version: computeContentVersion(content),
    versionGuard: getVersionGuard(computeContentVersion(content)),
    modifiedAtMs: 0, sizeBytes: Buffer.byteLength(content) };
}
function prepare(source: string, input: Record<string, unknown>) {
  return prepareVaultPatch(document(source), { ifMatch: computeContentVersion(source), ...input }).document;
}
const semantic = (code: string) => (error: unknown) => error instanceof VaultSemanticError && error.code === code;

test("heading replacements with children require explicit subtree confirmation in both replacement scopes", () => {
  for (const scope of [undefined, "content", "markerAndContent"]) {
    const input = { ...replace, ...(scope === undefined ? {} : { scope }) };
    for (const confirmation of [{}, { allowSubtreeReplacement: false }]) {
      assert.throws(() => prepare(section, { ...input, ...confirmation }), (error: unknown) => {
        assert.ok(error instanceof VaultSemanticError);
        assert.equal(error.code, "subtree_confirmation_required");
        assert.match(error.message, /allowSubtreeReplacement: true/u);
        assert.match(error.message, /within/u);
        return true;
      });
    }
    const next = prepare(section, { ...input, allowSubtreeReplacement: true });
    assert.ok(next.includes("new body"));
    assert.doesNotMatch(next, /keep B|keep C/u);
    assert.ok(next.endsWith("# Outside\nstay\n"));
  }
  for (const target of [null, []]) {
    assert.throws(() => prepare(section, { ...replace, target }), semantic("subtree_confirmation_required"));
    assert.doesNotMatch(prepare(section, { ...replace, target, allowSubtreeReplacement: true }), /keep B|stay/u);
  }
});

test("subtree protection follows exact Chinese and duplicate map keys", () => {
  const source = "# 总览\nintro\n## 重复\nfirst leaf\n## 重复\nsecond parent\n### 子节\nkeep child\n# 尾部\nstay\n";
  const keys = Object.keys(projectMap(buildModel(source)).headings["总览"]!);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  const leaf = prepare(source, { ...replace, target: ["总览", keys[0]!] });
  assert.ok(leaf.includes("second parent\n### 子节\nkeep child"));
  const target = ["总览", keys[1]!];
  assert.throws(() => prepare(source, { ...replace, target }), semantic("subtree_confirmation_required"));
  const confirmed = prepare(source, { ...replace, target, allowSubtreeReplacement: true });
  assert.ok(confirmed.includes("first leaf"));
  assert.doesNotMatch(confirmed, /keep child/u);
  assert.ok(confirmed.endsWith("# 尾部\nstay\n"));
});

test("leaf, within, rename and move edits keep their existing heading behavior", () => {
  const leaf = "# A\n```md\n## only a fenced example\n```\n";
  assert.ok(prepare(leaf, replace).includes("new body"));
  const within = prepare(section, { ...replace, within: 0 });
  assert.ok(within.includes("new body"));
  assert.ok(within.endsWith(section.slice(section.indexOf("## B"))));
  const renamed = prepare(section, { ...replace, scope: "marker", content: "Renamed" });
  assert.ok(renamed.includes("## B\nkeep B"));
  assert.ok(renamed.startsWith("# Renamed"));
  const moved = prepare(section, { targetType: "heading", target: ["A"], operation: "replace", scope: "parent",
    destination: { parent: ["Outside"], place: "last" } });
  assert.ok(moved.includes("keep B"));
  assert.ok(moved.includes("keep C"));
  const created = prepare(section, { ...replace, target: ["Missing"], createTargetIfMissing: true });
  assert.ok(created.includes("keep B"));
  assert.ok(created.includes("# Missing"));
  assert.throws(() => prepare("# A\nintro\n\nChild\n-----\nkeep\n", replace), semantic("subtree_confirmation_required"));
});

test("subtree confirmation is typed, narrowly scoped and never bypasses version preconditions", () => {
  for (const allowSubtreeReplacement of ["true", 1, null]) {
    assert.throws(() => prepare(section, { ...replace, allowSubtreeReplacement }), semantic("invalid_instruction"));
  }
  for (const input of [
    { ...replace, within: 0 }, { ...replace, scope: "marker" },
    { targetType: "frontmatter", target: "tags", operation: "replace", value: [] },
  ]) {
    assert.throws(() => prepare(section, { ...input, allowSubtreeReplacement: true }), semantic("invalid_instruction"));
  }
  assert.throws(() => prepare(section, { ...replace, allowSubtreeReplacement: true,
    ifMatch: computeContentVersion("stale") }), VersionConflictError);
  const ifMatchGuard = getVersionGuard(computeContentVersion(section));
  assert.throws(() => prepareVaultPatch(document(section), { ...replace, ifMatchGuard }), semantic("subtree_confirmation_required"));
  assert.throws(() => prepareVaultPatch(document(section), { ...replace, allowSubtreeReplacement: true,
    ifMatchGuard: getVersionGuard(computeContentVersion("stale")) }), VersionGuardConflictError);
  const next = prepareVaultPatch(document(section), { ...replace, allowSubtreeReplacement: true, ifMatchGuard }).document;
  assert.doesNotMatch(next, /keep B|keep C/u);
});

test("blocked subtree replacements and stale confirmations never stage or publish bytes", async t => {
  for (const kind of ["full", "guard"] as const) await t.test(kind, async t => {
    const temporary = path.resolve(".test-dist", ".test-tmp");
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(path.join(temporary, "obsidian-patch-guard-"));
    const vault = path.join(root, "vault");
    await mkdir(vault);
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = "\uFEFF" + section.replace(/\n/gu, "\r\n");
    const file = path.join(vault, "note.md");
    await writeFile(file, source);
    let writes = 0; let publishes = 0;
    const store = await VaultMutationStore.create(await VaultPathSandbox.create(vault), { io: {
      ...nativeMutationIO,
      writeFile: async (handle, bytes) => { writes++; await nativeMutationIO.writeFile(handle, bytes); },
      rename: async (from, to) => { publishes++; await nativeMutationIO.rename(from, to); },
    } });
    const version = computeContentVersion(source);
    const stale = computeContentVersion("stale");
    const options = kind === "full" ? { ifMatch: version } : { ifMatchGuard: getVersionGuard(version) };
    const staleOptions = kind === "full" ? { ifMatch: stale } : { ifMatchGuard: getVersionGuard(stale) };
    await assert.rejects(store.patch("note.md", { ...replace, ...options }), semantic("subtree_confirmation_required"));
    await assert.rejects(store.patch("note.md", { ...replace, allowSubtreeReplacement: true, ...staleOptions }),
      kind === "full" ? VersionConflictError : VersionGuardConflictError);
    assert.equal(writes, 0);
    assert.equal(publishes, 0);
    assert.equal(await readFile(file, "utf8"), source);
    assert.deepEqual(await readdir(vault), ["note.md"]);
    const result = await store.patch("note.md", { ...replace, allowSubtreeReplacement: true, ...options });
    const saved = await readFile(file, "utf8");
    assert.equal(writes, 1);
    assert.equal(publishes, 1);
    assert.ok(saved.startsWith("\uFEFF"));
    assert.doesNotMatch(saved, /(?<!\r)\n/u);
    assert.doesNotMatch(saved, /keep B|keep C/u);
    assert.equal(result.version, computeContentVersion(saved));
    assert.equal(result.versionGuard, getVersionGuard(result.version));
  });
});

test("flow and block array merges preserve unrelated source, BOM and line endings", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const bom of ["", "\uFEFF"]) {
      const prefix = bom + "---\n# untouched\nkeep: 'exact quote' # exact comment\n".replace(/\n/gu, newline);
      const suffix = "after: 'unchanged' # keep after\n---\n# Body\n正文\n".replace(/\n/gu, newline);
      for (const tags of ["tags: [mcp-smoke]\n", "tags:\n  - mcp-smoke\n"]) {
        const source = prefix + tags.replace(/\n/gu, newline) + suffix;
        for (const operation of ["append", "prepend"]) {
          const next = prepare(source, { targetType: "frontmatter", target: "tags", operation, value: ["smoke-extra"] });
          assert.deepEqual(parseFrontmatter(withoutBom(next)).value["tags"], operation === "append"
            ? ["mcp-smoke", "smoke-extra"] : ["smoke-extra", "mcp-smoke"]);
          assert.ok(next.startsWith(prefix));
          assert.ok(next.endsWith(suffix));
          if (newline === "\r\n") assert.doesNotMatch(next, /(?<!\r)\n/u);
        }
      }
    }
  }
});
