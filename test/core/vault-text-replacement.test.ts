import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { VaultPathError, VaultPathSandbox } from "../../src/core/path/vault-path.js";
import { computeContentVersion, InvalidContentVersionError, VersionConflictError } from "../../src/core/version/content-version.js";
import { VaultDocumentNotFoundError, VaultDocumentTooLargeError } from "../../src/core/file/read-vault-document.js";
import { VaultTextError } from "../../src/core/file/text-policy.js";
import { nativeMutationIO, type MutationIO } from "../../src/core/mutation/mutation-io.js";
import { MAX_TEXT_REPLACEMENT_INPUT_BYTES } from "../../src/core/mutation/prepare-text-replacement.js";
import { VaultMutationError, VaultMutationStore } from "../../src/core/mutation/vault-mutations.js";

async function fixture(t: TestContext, options: { io?: MutationIO; maxBytes?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-text-replacement-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sandbox = await VaultPathSandbox.create(vault);
  const store = await VaultMutationStore.create(sandbox, options);
  return { vault, sandbox, store, options };
}
function code(expected: string) {
  return (error: unknown) => error instanceof VaultMutationError && error.code === expected;
}

test("replacement preserves exact bytes outside a unique literal match without parsing Markdown or YAML", async t => {
  const f = await fixture(t);
  const prefix = "\uFEFF---\r\nbroken: [\n---\r# 中文🙂\r\ncafé|cafe\u0301\n";
  const oldText = "(needle.*)\\$";
  const newText = "$&|$1|$$|$`|$'|\\|替换🙂";
  const suffix = "\rending\r\nlast";
  const original = prefix + oldText + suffix;
  const expected = prefix + newText + suffix;
  await writeFile(path.join(f.vault, "note.md"), original);
  const result = await f.store.replaceText("note.md", oldText, newText, { ifMatch: computeContentVersion(original) });
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(expected));
  assert.deepEqual(result, { message: "OK", path: "note.md", version: computeContentVersion(Buffer.from(expected)),
    beforeSizeBytes: Buffer.byteLength(original), sizeBytes: Buffer.byteLength(expected), created: false, replacementCount: 1 });
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("matching is case sensitive and does not normalize NFC/NFD or Unicode", async t => {
  const f = await fixture(t);
  const original = "café|cafe\u0301|CAFE\u0301|中文🙂";
  await writeFile(path.join(f.vault, "note.txt"), original);
  const first = await f.store.replaceText("note.txt", "café", "咖啡", { ifMatch: computeContentVersion(original) });
  const afterFirst = "咖啡|cafe\u0301|CAFE\u0301|中文🙂";
  assert.deepEqual(await readFile(path.join(f.vault, "note.txt")), Buffer.from(afterFirst));
  await assert.rejects(f.store.replaceText("note.txt", "Cafe\u0301", "no", { ifMatch: first.version }), code("text_not_found"));
  const second = await f.store.replaceText("note.txt", "中文🙂", "🌧️", { ifMatch: first.version });
  assert.deepEqual(await readFile(path.join(f.vault, "note.txt")), Buffer.from("咖啡|cafe\u0301|CAFE\u0301|🌧️"));
  assert.equal(second.beforeSizeBytes, Buffer.byteLength(afterFirst));
});

test("zero, repeated, overlapping, empty-old and unchanged requests reject without staging", async t => {
  let writes = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO, writeFile: async (h, bytes) => {
    writes++; await nativeMutationIO.writeFile(h, bytes);
  } } });
  const cases = [
    { original: "one", oldText: "missing", newText: "two", error: "text_not_found", details: { matchCount: 0 } },
    { original: "one one", oldText: "one", newText: "two", error: "ambiguous_text", details: { matchCountAtLeast: 2 } },
    { original: "aaa", oldText: "aa", newText: "b", error: "ambiguous_text", details: { matchCountAtLeast: 2 } },
    { original: "", oldText: "one", newText: "two", error: "text_not_found", details: { matchCount: 0 } },
    { original: "one", oldText: "", newText: "two", error: "invalid_replacement", details: {} },
    { original: "one", oldText: "one", newText: "one", error: "no_change", details: {} },
  ];
  for (const c of cases) {
    await writeFile(path.join(f.vault, "note.md"), c.original);
    await assert.rejects(f.store.replaceText("note.md", c.oldText, c.newText, { ifMatch: computeContentVersion(c.original) }), (error: unknown) => {
      assert.ok(error instanceof VaultMutationError);
      assert.equal(error.code, c.error);
      assert.deepEqual(error.details, { path: "note.md", ...c.details });
      if (c.error === "ambiguous_text") assert.match(error.message, /expand oldText/u);
      return true;
    });
    assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(c.original));
    assert.deepEqual(await readdir(f.vault), ["note.md"]);
  }
  assert.equal(writes, 0);
});

test("empty replacement deletes the unique match and can produce an empty existing file", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vault, "note.md"), "prefix中文suffix");
  const partial = await f.store.replaceText("note.md", "中文", "", { ifMatch: computeContentVersion("prefix中文suffix") });
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from("prefixsuffix"));
  const empty = await f.store.replaceText("note.md", "prefixsuffix", "", { ifMatch: partial.version });
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.alloc(0));
  assert.equal(empty.version, computeContentVersion(Buffer.alloc(0)));
  assert.equal(empty.sizeBytes, 0);
  assert.equal(empty.beforeSizeBytes, Buffer.byteLength("prefixsuffix"));
  assert.equal(empty.created, false);
  assert.equal(empty.replacementCount, 1);
});

test("replacement requires a full current version and never creates a missing target", async t => {
  let writes = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO, writeFile: async (h, bytes) => {
    writes++; await nativeMutationIO.writeFile(h, bytes);
  } } });
  await writeFile(path.join(f.vault, "note.md"), "old");
  const missing = undefined as unknown as { readonly ifMatch: string };
  await assert.rejects(f.store.replaceText("note.md", "old", "new", missing), code("if_match_required"));
  await assert.rejects(f.store.replaceText("note.md", "old", "new", {} as { ifMatch: string }), code("if_match_required"));
  await assert.rejects(f.store.replaceText("note.md", "old", "new", { ifMatch: "sha256:1234" }), InvalidContentVersionError);
  await assert.rejects(f.store.replaceText("note.md", "old", "new", { ifMatch: computeContentVersion("stale") }), VersionConflictError);
  await assert.rejects(f.store.replaceText("nested/missing.md", "old", "new", { ifMatch: computeContentVersion("old") }), VaultDocumentNotFoundError);
  assert.equal(writes, 0);
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from("old"));
});

test("replacement shares path and text validity guards before staging", async t => {
  let writes = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO, writeFile: async (h, bytes) => {
    writes++; await nativeMutationIO.writeFile(h, bytes);
  } } });
  const options = { ifMatch: computeContentVersion("old") };
  await writeFile(path.join(f.vault, "note.md"), "old");
  for (const inputPath of ["/absolute.md", "../escape.md", ".obsidian/config.json", "NUL.md"]) {
    await assert.rejects(f.store.replaceText(inputPath, "old", "new", options), VaultPathError);
  }
  await assert.rejects(f.store.replaceText("binary.png", "old", "new", options), VaultTextError);
  for (const invalid of ["\0", "\uD800", "\uDC00"]) {
    await assert.rejects(f.store.replaceText("note.md", invalid, "new", options), VaultTextError);
    await assert.rejects(f.store.replaceText("note.md", "old", invalid, options), VaultTextError);
  }
  assert.equal(writes, 0);
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from("old"));
});

test("replacement input uses a combined inclusive 4 MiB UTF-8 limit independent of document budget", async t => {
  let writes = 0;
  const f = await fixture(t, { maxBytes: MAX_TEXT_REPLACEMENT_INPUT_BYTES + 16,
    io: { ...nativeMutationIO, writeFile: async (h, bytes) => { writes++; await nativeMutationIO.writeFile(h, bytes); } } });
  const oldText = "中";
  const newText = "a".repeat(MAX_TEXT_REPLACEMENT_INPUT_BYTES - Buffer.byteLength(oldText));
  await writeFile(path.join(f.vault, "note.md"), oldText);
  const result = await f.store.replaceText("note.md", oldText, newText, { ifMatch: computeContentVersion(oldText) });
  assert.equal(result.beforeSizeBytes, 3);
  assert.equal(result.sizeBytes, MAX_TEXT_REPLACEMENT_INPUT_BYTES - 3);
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(newText));
  await assert.rejects(f.store.replaceText("note.md", oldText, newText + "a", { ifMatch: result.version }), code("too_large"));
  assert.equal(writes, 1);
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("old and resulting document sizes inherit the store exact-byte budget", async t => {
  let writes = 0;
  const f = await fixture(t, { maxBytes: 7, io: { ...nativeMutationIO,
    writeFile: async (h, bytes) => { writes++; await nativeMutationIO.writeFile(h, bytes); } } });
  await writeFile(path.join(f.vault, "note.md"), "中文ab");
  await assert.rejects(f.store.replaceText("note.md", "a", "", { ifMatch: computeContentVersion("中文ab") }), VaultDocumentTooLargeError);
  await writeFile(path.join(f.vault, "note.md"), "中文a");
  await assert.rejects(f.store.replaceText("note.md", "a", "🙂", { ifMatch: computeContentVersion("中文a") }), code("too_large"));
  assert.equal(writes, 0);
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from("中文a"));
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
  const atLimit = await f.store.replaceText("note.md", "a", "b", { ifMatch: computeContentVersion("中文a") });
  assert.equal(atLimit.beforeSizeBytes, 7);
  assert.equal(atLimit.sizeBytes, 7);
  assert.equal(writes, 1);
});

test("same-path replacements serialize across stores and never retry a stale version", async t => {
  let writes = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO, writeFile: async (h, bytes) => {
    writes++; await nativeMutationIO.writeFile(h, bytes);
  } } });
  const second = await VaultMutationStore.create(f.sandbox, f.options);
  await writeFile(path.join(f.vault, "note.md"), "old");
  const options = { ifMatch: computeContentVersion("old") as string };
  const first = f.store.replaceText("note.md", "old", "one", options);
  const pending = second.replaceText("note.md", "old", "two", options);
  options.ifMatch = "changed by caller after invocation";
  const results = await Promise.allSettled([first, pending]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.some(r => r.status === "rejected" && r.reason instanceof VersionConflictError));
  assert.equal(writes, 1);
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from("one"));
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("external changes after replacement staging are preserved without publication or retry", async t => {
  let vault = ""; let writes = 0; let publishes = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO,
    writeFile: async (h, bytes) => { writes++; await nativeMutationIO.writeFile(h, bytes); },
    syncFile: async h => { await nativeMutationIO.syncFile(h); await writeFile(path.join(vault, "note.md"), "SYNC"); },
    rename: async (a, b) => { publishes++; await nativeMutationIO.rename(a, b); },
  } });
  vault = f.vault;
  await writeFile(path.join(vault, "note.md"), "old");
  await assert.rejects(f.store.replaceText("note.md", "old", "new", { ifMatch: computeContentVersion("old") }), VersionConflictError);
  assert.equal(writes, 1);
  assert.equal(publishes, 0);
  assert.deepEqual(await readFile(path.join(vault, "note.md")), Buffer.from("SYNC"));
  assert.deepEqual(await readdir(vault), ["note.md"]);
});

test("replacement write, fsync and rename failures retain original bytes and clean staging", async t => {
  for (const phase of ["write", "fsync", "rename"] as const) {
    await t.test(phase, async t => {
      let fail = true; let publishes = 0;
      const fault = () => { if (fail) throw new Error("injected replacement failure"); };
      const f = await fixture(t, { io: { ...nativeMutationIO,
        writeFile: async (h, bytes) => { await nativeMutationIO.writeFile(h, bytes); if (phase === "write") fault(); },
        syncFile: async h => { if (phase === "fsync") fault(); await nativeMutationIO.syncFile(h); },
        rename: async (a, b) => { publishes++; if (phase === "rename") fault(); await nativeMutationIO.rename(a, b); },
      } });
      const original = "\uFEFFold\r\n";
      await writeFile(path.join(f.vault, "note.md"), original);
      const options = { ifMatch: computeContentVersion(original) };
      await assert.rejects(f.store.replaceText("note.md", "old", "new", options), /injected replacement failure/u);
      assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(original));
      assert.deepEqual(await readdir(f.vault), ["note.md"]);
      assert.equal(publishes, phase === "rename" ? 1 : 0);
      fail = false;
      const saved = await f.store.replaceText("note.md", "old", "new", options);
      assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from("\uFEFFnew\r\n"));
      assert.equal(saved.beforeSizeBytes, Buffer.byteLength(original));
      assert.equal(saved.replacementCount, 1);
    });
  }
});
