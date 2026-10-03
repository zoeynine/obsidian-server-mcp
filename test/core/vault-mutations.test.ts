import * as assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { VaultPathError, VaultPathSandbox } from "../../src/core/path/vault-path.js";
import { computeContentVersion, VersionConflictError } from "../../src/core/version/content-version.js";
import { VaultTextError } from "../../src/core/file/text-policy.js";
import { InvalidVaultDocumentEncodingError, readVaultDocument } from "../../src/core/file/read-vault-document.js";
import { getVaultDocumentMap, listVaultFiles, listVaultTags, searchVaultQuery } from "../../src/core/index.js";
import { nativeMutationIO, type MutationIO } from "../../src/core/mutation/mutation-io.js";
import { VaultMutationError, VaultMutationStore } from "../../src/core/mutation/vault-mutations.js";

async function fixture(t: TestContext, options: { io?: MutationIO; maxBytes?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-mutation-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sandbox = await VaultPathSandbox.create(vault);
  const store = await VaultMutationStore.create(sandbox, options);
  return { root, vault, sandbox, store, options };
}
function code(expected: string) {
  return (error: unknown) => error instanceof VaultMutationError && error.code === expected;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("write checks exact-byte ifMatch and preserves BOM/CRLF versions", async t => {
  const f = await fixture(t);
  const content = "\uFEFF# 中文\r\ntext\r\n";
  const created = await f.store.write("note.md", content);
  assert.equal(created.created, true);
  assert.equal(created.version, computeContentVersion(Buffer.from(content)));
  assert.equal(created.sizeBytes, Buffer.byteLength(content));
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(content));
  await assert.rejects(f.store.write("note.md", "lost"), code("if_match_required"));
  await assert.rejects(f.store.write("note.md", "lost", { ifMatch: computeContentVersion(content.slice(1)) }), VersionConflictError);
  const written = await f.store.write("note.md", "new", { ifMatch: created.version });
  assert.equal(written.created, false);
  assert.equal(written.version, computeContentVersion("new"));
  await assert.rejects(f.store.write("gone.md", "lost", { ifMatch: created.version }), code("version_conflict"));
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("append follows Local REST newline semantics for absent, empty, LF, CRLF and unterminated files", async t => {
  const f = await fixture(t);
  for (const [i, initial] of [undefined, "", "one", "one\n", "one\r\n", "one\r"].entries()) {
    const filename = `append-${i}.md`;
    if (initial !== undefined) await writeFile(path.join(f.vault, filename), initial);
    const result = await f.store.append(filename, "二", initial === undefined ? {} : { ifMatch: computeContentVersion(initial) });
    const expected = initial === undefined ? "二" : initial + (initial.endsWith("\n") ? "" : "\n") + "二";
    assert.equal(await readFile(path.join(f.vault, filename), "utf8"), expected);
    assert.equal(result.version, computeContentVersion(expected));
  }
  await assert.rejects(f.store.append("append-1.md", "again"), code("if_match_required"));
});

test("nested paths use the fixture filesystem's permissions", async t => {
  const f = await fixture(t);
  for (const filename of ["notes/note.md", "资料/note.md", "projects/note.md", "folder with spaces/note.md"]) {
    assert.equal((await f.store.write(filename, "text")).created, true);
    assert.equal(await readFile(path.join(f.vault, filename), "utf8"), "text");
  }
});

test("hidden same-directory temp files are written and synced before atomic publication", async t => {
  const events: string[] = [];
  const f = await fixture(t, { io: { ...nativeMutationIO,
    writeFile: async (handle, bytes) => { events.push("write"); await nativeMutationIO.writeFile(handle, bytes); },
    syncFile: async handle => { events.push("file-sync"); await nativeMutationIO.syncFile(handle); },
    link: async (temporary, destination) => {
      events.push("publish");
      assert.equal(path.dirname(temporary), path.dirname(destination));
      assert.match(path.basename(temporary), /^\.obsidian-mcp-.*\.tmp$/u);
      assert.equal(await readFile(temporary, "utf8"), "complete");
      await nativeMutationIO.link(temporary, destination);
    },
    unlink: async temporary => { events.push("cleanup"); await nativeMutationIO.unlink(temporary); },
  } });
  const result = await f.store.write("note.md", "complete");
  assert.deepEqual(events, ["write", "file-sync", "publish", "cleanup"]);
  assert.equal(result.message, "OK");
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("temporary artifacts remain hidden and inaccessible through every public read/discovery path", async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { io: { ...nativeMutationIO, syncFile: async handle => {
    await nativeMutationIO.syncFile(handle); entered.resolve(); await release.promise;
  } } });
  const pending = f.store.write("note.md", "# temporary-tag");
  try {
    await entered.promise;
    const temporary = (await readdir(f.vault))[0]!;
    assert.match(temporary, /^\.obsidian-mcp-/u);
    const reader = (p: string) => readVaultDocument(f.sandbox, p);
    assert.deepEqual(await listVaultFiles(f.sandbox), {files: []});
    assert.deepEqual(await searchVaultQuery(f.sandbox, reader, {var: "path"}), []);
    assert.deepEqual(await listVaultTags(f.sandbox, reader), {tags: []});
    await assert.rejects(reader(temporary), VaultPathError);
    await assert.rejects(getVaultDocumentMap(reader, temporary), VaultPathError);
    await assert.rejects(f.store.write(temporary, "overwrite"), VaultPathError);
  } finally { release.resolve(); }
  await pending;
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("generic frontmatter and heading patch use the shared commit path", async t => {
  const f = await fixture(t);
  const original = "\uFEFF---\r\nkeep: 'quoted' # retained\r\ntags: [one]\r\n---\r\n# Title\r\nBody\r\n";
  await writeFile(path.join(f.vault, "patch.md"), original);
  const result = await f.store.patch("patch.md", { targetType: "frontmatter", target: "tags", operation: "append", value: ["two"], ifMatch: computeContentVersion(original) });
  const next = await readFile(path.join(f.vault, "patch.md"), "utf8");
  assert.ok(next.includes("keep: 'quoted' # retained\r\n"));
  assert.ok(next.endsWith("# Title\r\nBody\r\n"));
  assert.ok(next.startsWith("\uFEFF---\r\n"));
  assert.equal(result.version, computeContentVersion(next));
  await assert.rejects(f.store.patch("patch.md", { targetType: "frontmatter", target: "tags", operation: "delete", ifMatch: computeContentVersion(original) }), VersionConflictError);
  const heading = await f.store.patch("patch.md", { targetType: "heading", target: ["Title"], operation: "replace", scope: "marker", content: "Renamed", ifMatch: result.version });
  assert.equal(heading.version, computeContentVersion(await readFile(path.join(f.vault, "patch.md"))));
  assert.ok((await readFile(path.join(f.vault, "patch.md"), "utf8")).includes("# Renamed"));
  await assert.rejects(f.store.patch("patch.md", { targetType: "frontmatter", target: "tags", operation: "delete" }), code("if_match_required"));
});

test("same-path requests serialize across instances and stale append/patch are never retried", async t => {
  let writes = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO, writeFile: async (h, bytes) => { writes++; await nativeMutationIO.writeFile(h, bytes); } } });
  await writeFile(path.join(f.vault, "note.md"), "# Title\nbody");
  const second = await VaultMutationStore.create(f.sandbox, f.options);
  const ifMatch = computeContentVersion("# Title\nbody");
  const results = await Promise.allSettled([
    f.store.append("note.md", "one", { ifMatch }),
    second.patch("note.md", { targetType: "heading", target: ["Title"], operation: "append", content: "two", ifMatch }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(results.some(r => r.status === "rejected" && r.reason instanceof VersionConflictError));
  assert.equal(writes, 1);
  assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "# Title\nbody\none");
});

test("different paths progress independently while another write is paused", async t => {
  const entered = deferred(); const release = deferred();
  let first = true;
  const f = await fixture(t, { io: { ...nativeMutationIO, writeFile: async (h, bytes) => {
    await nativeMutationIO.writeFile(h, bytes);
    if (first) { first = false; entered.resolve(); await release.promise; }
  } } });
  const paused = f.store.write("paused.md", "one");
  try { await entered.promise; assert.equal((await f.store.write("other.md", "two")).created, true); }
  finally { release.resolve(); }
  await paused;
});

test("write, fsync and replace failures retain original bytes, clean temps and release locks", async t => {
  for (const phase of ["write", "fsync", "replace"] as const) {
    await t.test(phase, async t => {
      let fail = true; let publishes = 0;
      const fault = () => { if (fail) throw new Error("injected private filesystem failure"); };
      const f = await fixture(t, { io: { ...nativeMutationIO,
        writeFile: async (h, bytes) => { await nativeMutationIO.writeFile(h, bytes); if (phase === "write") fault(); },
        syncFile: async h => { if (phase === "fsync") fault(); await nativeMutationIO.syncFile(h); },
        rename: async (a, b) => { publishes++; if (phase === "replace") fault(); await nativeMutationIO.rename(a, b); },
      } });
      await writeFile(path.join(f.vault, "note.md"), "old");
      await assert.rejects(f.store.append("note.md", "new", { ifMatch: computeContentVersion("old") }), /injected/u);
      assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "old");
      assert.equal(publishes, phase === "replace" ? 1 : 0);
      assert.deepEqual(await readdir(f.vault), ["note.md"]);
      fail = false;
      await f.store.append("note.md", "new", { ifMatch: computeContentVersion("old") });
      assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "old\nnew");
    });
  }
});

test("final exact-byte revalidation catches external changes for append and patch without retry", async t => {
  for (const operation of ["append", "patch"]) {
    let vault = ""; let publishes = 0; let writes = 0;
    const f = await fixture(t, { io: { ...nativeMutationIO,
      writeFile: async (h, bytes) => { writes++; await nativeMutationIO.writeFile(h, bytes); },
      syncFile: async h => { await nativeMutationIO.syncFile(h); await writeFile(path.join(vault, "note.md"), "SYNC"); },
      rename: async (a, b) => { publishes++; await nativeMutationIO.rename(a, b); },
    } });
    vault = f.vault;
    await writeFile(path.join(vault, "note.md"), "# Title\nold");
    const ifMatch = computeContentVersion("# Title\nold");
    await assert.rejects(operation === "append" ? f.store.append("note.md", "new", { ifMatch }) :
      f.store.patch("note.md", {targetType: "heading", target: ["Title"], operation: "append", content: "new", ifMatch}), VersionConflictError);
    assert.equal(publishes, 0); assert.equal(writes, 1);
    assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), "SYNC");
    assert.deepEqual(await readdir(vault), ["note.md"]);
  }
});

test("atomic create refuses a last-moment destination; EXDEV has no copy fallback", async t => {
  for (const conflict of ["EEXIST", "EXDEV"]) {
    let calls = 0;
    const f = await fixture(t, { io: { ...nativeMutationIO, link: async (a, b) => {
      calls++;
      if (conflict === "EXDEV") throw Object.assign(new Error("injected EXDEV"), {code: "EXDEV"});
      await writeFile(b, "racer", {flag: "wx"}); await nativeMutationIO.link(a, b);
    } } });
    await assert.rejects(f.store.write("race.md", "ours"), code(conflict === "EEXIST" ? "target_changed" : "cross_device"));
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(f.vault), conflict === "EEXIST" ? ["race.md"] : []);
    if (conflict === "EEXIST") assert.equal(await readFile(path.join(f.vault, "race.md"), "utf8"), "racer");
  }
});

test("swapped parent/junction is rejected, with safe cleanup refusal instead of following it", async t => {
  let vault = ""; let outside = "";
  const f = await fixture(t, { io: { ...nativeMutationIO, closeFile: async h => {
    await nativeMutationIO.closeFile(h);
    await rename(path.join(vault, "notes"), path.join(vault, "original"));
    await symlink(outside, path.join(vault, "notes"), process.platform === "win32" ? "junction" : "dir");
  } } });
  vault = f.vault; outside = path.join(f.root, "outside");
  await mkdir(outside); await mkdir(path.join(vault, "notes"));
  await writeFile(path.join(vault, "notes/note.md"), "old");
  await assert.rejects(f.store.write("notes/note.md", "new", { ifMatch: computeContentVersion("old") }), code("cleanup_failed"));
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await readFile(path.join(vault, "original/note.md"), "utf8"), "old");
  const leftovers = await readdir(path.join(vault, "original"));
  assert.equal(leftovers.filter(name => name.startsWith(".obsidian-mcp-")).length, 1);
});

test("shared path/text guards protect mutations, including reserved names and binary/NUL input", async t => {
  const f = await fixture(t, { maxBytes: 64 });
  for (const input of ["/absolute.md", "../escape.md", ".obsidian/config.json", "NUL.md"]) {
    await assert.rejects(f.store.write(input, "new"), VaultPathError);
  }
  for (const input of ["image.png", "data.zip", "compressed.svgz"]) await assert.rejects(f.store.append(input, "new"), VaultTextError);
  for (const content of ["\0", "\uD800"]) await assert.rejects(f.store.write("text.md", content), VaultTextError);
  await assert.rejects(f.store.write("text.md", "中".repeat(22)), code("too_large"));
  await writeFile(path.join(f.vault, "invalid.md"), Buffer.from([0xff]));
  await assert.rejects(f.store.write("invalid.md", "new", { ifMatch: computeContentVersion(Buffer.from([0xff])) }), InvalidVaultDocumentEncodingError);
  await writeFile(path.join(f.vault, "with-nul.md"), "a\0b");
  await assert.rejects(f.store.append("with-nul.md", "new", { ifMatch: computeContentVersion("a\0b") }), VaultTextError);
  await writeFile(path.join(f.vault, "Name.md"), "old");
  await assert.rejects(f.store.write("name.md", "new"), (error: unknown) => error instanceof VaultPathError && error.code === "filename_conflict");
  await link(path.join(f.vault, "Name.md"), path.join(f.vault, "alias.md"));
  await assert.rejects(f.store.write("Name.md", "new", { ifMatch: computeContentVersion("old") }), code("unsafe_target"));
  assert.equal((await readdir(f.vault)).some(name => name.startsWith(".obsidian-mcp-")), false);
});

test("cleanup failures report an aborted write or a saved-note warning without retrying", async t => {
  for (const beforePublish of [true, false]) {
    let calls = 0;
    const f = await fixture(t, { io: { ...nativeMutationIO,
      writeFile: async (h, bytes) => { await nativeMutationIO.writeFile(h, bytes); if (beforePublish) throw new Error("write fault"); },
      link: async (a, b) => { calls++; await nativeMutationIO.link(a, b); },
      unlink: async () => { throw new Error("injected cleanup failure"); },
    } });
    if (beforePublish) await assert.rejects(f.store.write("note.md", "new"), code("cleanup_failed"));
    else {
      const saved = await f.store.write("note.md", "new");
      assert.equal(saved.message, "OK");
      assert.equal(saved.version, computeContentVersion("new"));
      assert.equal(saved.warnings?.[0]?.code, "temporary_cleanup_failed");
      assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "new");
    }
    assert.equal(calls, beforePublish ? 0 : 1);
    assert.deepEqual(await listVaultFiles(f.sandbox), {files: beforePublish ? [] : ["note.md"]});
  }
});

test("a successful create with a leftover temporary hard link rejects mutation with its returned version", async t => {
  let temporary = ""; let cleanupCalls = 0;
  const f = await fixture(t, { io: { ...nativeMutationIO, unlink: async filename => {
    temporary = filename; cleanupCalls++;
    throw new Error("injected cleanup failure " + filename);
  } } });
  const saved = await f.store.write("note.md", "saved");
  assert.equal(saved.message, "OK");
  assert.equal(saved.created, true);
  assert.equal(saved.version, computeContentVersion("saved"));
  assert.equal(saved.warnings?.[0]?.code, "temporary_cleanup_failed");
  const target = path.join(f.vault, "note.md");
  const targetStats = await lstat(target);
  const temporaryStats = await lstat(temporary);
  assert.equal(targetStats.nlink, 2);
  assert.equal(temporaryStats.nlink, 2);
  assert.equal(targetStats.dev, temporaryStats.dev);
  assert.equal(targetStats.ino, temporaryStats.ino);

  await assert.rejects(f.store.append("note.md", "next", { ifMatch: saved.version }), (error: unknown) => {
    assert.ok(error instanceof VaultMutationError);
    assert.equal(error.code, "unsafe_target");
    assert.equal(error.message, "Mutation target must be a regular file with one hard link; multiple hard links may indicate stale temporary cleanup residue");
    assert.deepEqual(error.details, { path: "note.md" });
    assert.equal(error.message.includes(f.root), false);
    assert.equal(JSON.stringify(error).includes(f.root), false);
    return true;
  });
  assert.equal(cleanupCalls, 1);
  assert.equal(await readFile(target, "utf8"), "saved");
  assert.equal(await readFile(temporary, "utf8"), "saved");
  assert.equal((await lstat(target)).nlink, 2);
  assert.deepEqual(await readdir(f.vault), [path.basename(temporary), "note.md"]);
});
