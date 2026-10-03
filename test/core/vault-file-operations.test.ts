import * as assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { VaultPathError, VaultPathSandbox } from "../../src/core/path/vault-path.js";
import { computeContentVersion, VersionConflictError } from "../../src/core/version/content-version.js";
import { VaultMutationError, VaultMutationStore } from "../../src/core/mutation/vault-mutations.js";
import { nativeMutationIO, type MutationIO } from "../../src/core/mutation/mutation-io.js";
import { listVaultFiles, listVaultTags, readVaultDocument, searchVaultQuery } from "../../src/core/index.js";

async function fixture(t: TestContext, io: MutationIO = nativeMutationIO) {
  const root = await mkdtemp(path.join(tmpdir(), "obsidian-file-ops-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const sandbox = await VaultPathSandbox.create(vault);
  const store = await VaultMutationStore.create(sandbox, { io });
  return { root, vault, sandbox, store };
}
const code = (expected: string) => (e: unknown) => e instanceof VaultMutationError && e.code === expected;
const errno = (value: string) => Object.assign(new Error(`injected ${value}`), { code: value });
const missing = (filename: string) => assert.rejects(lstat(filename), { code: "ENOENT" });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("move follows pinned destination normalization, directory suffix, overwrite flag and OK shape", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 254, 1]);
  await writeFile(path.join(f.vault, "image.png"), bytes);
  assert.deepEqual(await f.store.move("image.png", "  archive\\nested//  "), {
    message: "OK", oldPath: "image.png", newPath: "archive/nested/image.png",
  });
  await missing(path.join(f.vault, "image.png"));
  assert.deepEqual(await readFile(path.join(f.vault, "archive/nested/image.png")), bytes);
  await f.store.move("archive/nested/image.png", "");
  await writeFile(path.join(f.vault, "destination.png"), "old destination");
  await assert.rejects(f.store.move("image.png", "destination.png"), code("destination_exists"));
  assert.equal(await readFile(path.join(f.vault, "destination.png"), "utf8"), "old destination");
  await f.store.move("image.png", "destination.png", { allowOverwrite: true });
  await missing(path.join(f.vault, "image.png"));
  assert.deepEqual(await readFile(path.join(f.vault, "destination.png")), bytes);
  assert.deepEqual(await f.store.move("missing.md", "missing.md"), { message: "OK", oldPath: "missing.md", newPath: "missing.md" });
  await assert.rejects(f.store.move("missing.md", "other.md"), code("not_found"));
});

test("move retains source bytes and leaves referring notes unchanged", async t => {
  const f = await fixture(t);
  const content = "\uFEFF# Title\r\nbody\r\n";
  await writeFile(path.join(f.vault, "note.md"), content);
  await writeFile(path.join(f.vault, "referrer.md"), "[[note]]");
  await assert.rejects(f.store.move("note.md", "new.md", { ifMatch: computeContentVersion(content.slice(1)) }), VersionConflictError);
  await f.store.move("note.md", "new.md", { ifMatch: computeContentVersion(content) });
  assert.equal(await readFile(path.join(f.vault, "new.md"), "utf8"), content);
  assert.equal(await readFile(path.join(f.vault, "referrer.md"), "utf8"), "[[note]]");
  assert.equal((await lstat(path.join(f.vault, "new.md"))).nlink, 1);
});

test("default move never clobbers a destination created at the final syscall", async t => {
  let calls = 0;
  const f = await fixture(t, { ...nativeMutationIO, link: async (source, target) => {
    calls++;
    await writeFile(target, "raced-in", { flag: "wx" });
    await nativeMutationIO.link(source, target);
  } });
  await writeFile(path.join(f.vault, "source.md"), "source");
  await assert.rejects(f.store.move("source.md", "target.md"), code("destination_exists"));
  assert.equal(await readFile(path.join(f.vault, "source.md"), "utf8"), "source");
  assert.equal(await readFile(path.join(f.vault, "target.md"), "utf8"), "raced-in");
  assert.equal(calls, 1);
});

test("a denied source unlink rolls back only the created destination link", async t => {
  let sourceUnlinks = 0;
  const f = await fixture(t, { ...nativeMutationIO, unlink: async filename => {
    if (path.basename(filename) === "source.md") { sourceUnlinks++; throw errno("EACCES"); }
    await nativeMutationIO.unlink(filename);
  } });
  await writeFile(path.join(f.vault, "source.md"), "source");
  await assert.rejects(f.store.move("source.md", "target.md"), { code: "EACCES" });
  assert.equal(sourceUnlinks, 1);
  assert.equal(await readFile(path.join(f.vault, "source.md"), "utf8"), "source");
  assert.equal((await lstat(path.join(f.vault, "source.md"))).nlink, 1);
  await missing(path.join(f.vault, "target.md"));
});

test("move cleanup failure preserves both copies and reports paths without retry", async t => {
  const f = await fixture(t, { ...nativeMutationIO, unlink: async () => { throw errno("EPERM"); } });
  await writeFile(path.join(f.vault, "source.md"), "retained");
  await assert.rejects(f.store.move("source.md", "target.md"), e => {
    assert.ok(e instanceof VaultMutationError);
    assert.equal(e.code, "source_cleanup_failed");
    assert.deepEqual(e.details, { path: "source.md", destination: "target.md" });
    return true;
  });
  assert.equal(await readFile(path.join(f.vault, "source.md"), "utf8"), "retained");
  assert.equal(await readFile(path.join(f.vault, "target.md"), "utf8"), "retained");
});

test("move detects a source edit after link publication and safely rolls back without retry", async t => {
  let calls = 0;
  const f = await fixture(t, { ...nativeMutationIO, link: async (source, target) => {
    calls++; await nativeMutationIO.link(source, target); await writeFile(source, "external edit");
  } });
  await writeFile(path.join(f.vault, "source.md"), "original");
  await assert.rejects(f.store.move("source.md", "target.md", { ifMatch: computeContentVersion("original") }), VersionConflictError);
  assert.equal(calls, 1);
  assert.equal(await readFile(path.join(f.vault, "source.md"), "utf8"), "external edit");
  await missing(path.join(f.vault, "target.md"));
});

test("move rollback refuses changed destinations and the sole surviving file", async t => {
  for (const change of ["destination", "source"] as const) {
    const f = await fixture(t, { ...nativeMutationIO, unlink: async filename => {
      if (path.basename(filename) === "source.md") {
        const target = path.join(path.dirname(filename), "target.md");
        if (change === "destination") { await unlink(target); await writeFile(target, "external"); }
        else await unlink(filename);
        throw errno("EACCES");
      }
      await nativeMutationIO.unlink(filename);
    } });
    await writeFile(path.join(f.vault, "source.md"), "source");
    await assert.rejects(f.store.move("source.md", "target.md"), code("source_cleanup_failed"));
    assert.equal(await readFile(path.join(f.vault, "target.md"), "utf8"), change === "destination" ? "external" : "source");
  }
});

test("delete defaults to unique protected Vault trash and preserves attachment bytes", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 254, 1]);
  const paths: string[] = [];
  for (let i = 0; i < 2; i++) {
    await writeFile(path.join(f.vault, "asset.png"), bytes);
    const receipt = await f.store.delete("asset.png");
    assert.equal(receipt.message, "OK");
    assert.equal(receipt.permanent, false);
    if (receipt.permanent) throw new Error("Expected recoverable deletion");
    assert.match(receipt.trashPath, /^\.trash\/[^/]+\/asset\.png$/u);
    assert.deepEqual(await readFile(path.join(f.vault, receipt.trashPath)), bytes);
    paths.push(receipt.trashPath);
    await missing(path.join(f.vault, "asset.png"));
    await assert.rejects(f.store.delete(receipt.trashPath), VaultPathError);
    await assert.rejects(f.store.move(receipt.trashPath, "restore.png"), VaultPathError);
  }
  assert.notEqual(paths[0], paths[1]);
  await writeFile(path.join(f.vault, "note.md"), "#hidden");
  await f.store.delete("note.md");
  assert.deepEqual(await listVaultFiles(f.sandbox), { files: [] });
  const reader = (p: string) => readVaultDocument(f.sandbox, p);
  assert.deepEqual(await searchVaultQuery(f.sandbox, reader, {var: "path"}), []);
  assert.deepEqual(await listVaultTags(f.sandbox, reader), {tags: []});
});

test("delete preserves the permanent flag, missing-file failure and optional exact-byte precondition", async t => {
  const f = await fixture(t);
  const content = "\uFEFFline\r\n";
  await writeFile(path.join(f.vault, "note.md"), content);
  await assert.rejects(f.store.delete("note.md", { ifMatch: computeContentVersion(content.slice(1)) }), VersionConflictError);
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
  assert.deepEqual(await f.store.delete("note.md", { permanent: true, ifMatch: computeContentVersion(content) }), {
    message: "OK", path: "note.md", permanent: true,
  });
  assert.deepEqual(await readdir(f.vault), []);
  await assert.rejects(f.store.delete("note.md"), code("not_found"));
});

test("delete rechecks exact bytes after reserving trash and cleans an aborted reservation", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vault, "note.md"), "original");
  const resolve = f.sandbox.resolveInternalTrash.bind(f.sandbox);
  let changed = false;
  f.sandbox.resolveInternalTrash = async (child = "", options = {}) => {
    const result = await resolve(child, options);
    if (!changed && child.includes("/")) { changed = true; await writeFile(path.join(f.vault, "note.md"), "external"); }
    return result;
  };
  await assert.rejects(f.store.delete("note.md", { ifMatch: computeContentVersion("original") }), VersionConflictError);
  assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "external");
  assert.deepEqual(await readdir(path.join(f.vault, ".trash")), []);
});

test("move and delete refuse escape, protected internals, aliases, directories and hard links", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vault, "note.md"), "safe");
  for (const unsafe of ["../escape.md", "/absolute.md", "C:\\absolute.md", "NUL.md", ".obsidian/settings.json", ".trash/x", "note.md\0"]) {
    await assert.rejects(f.store.delete(unsafe), VaultPathError);
    await assert.rejects(f.store.move("note.md", unsafe), VaultPathError);
  }
  for (const suffix of ["../escape.md", "nested/../../escape.md", "nested\\..\\escape.md"]) {
    await assert.rejects(f.store.move("note.md", suffix), VaultPathError);
  }
  await assert.rejects(f.store.move("note.md", "NOTE.md"), VaultPathError);
  await mkdir(path.join(f.vault, "directory"));
  await assert.rejects(f.store.delete("directory"), code("unsafe_target"));
  await assert.rejects(f.store.move("directory", "another"), code("unsafe_target"));
  await assert.rejects(f.store.move("note.md", "directory", { allowOverwrite: true }), code("unsafe_target"));
  await link(path.join(f.vault, "note.md"), path.join(f.vault, "extra.md"));
  await assert.rejects(f.store.delete("note.md"), code("unsafe_target"));
  await assert.rejects(f.store.move("note.md", "moved.md"), code("unsafe_target"));
});

test("symlinked sources, destinations and trash never reach their external targets", async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "note.md"), "external");
  await writeFile(path.join(f.vault, "note.md"), "inside");
  await symlink(outside, path.join(f.vault, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.store.move("linked/note.md", "moved.md"), VaultPathError);
  await assert.rejects(f.store.move("note.md", "linked/moved.md"), VaultPathError);
  await assert.rejects(f.store.delete("linked/note.md"), VaultPathError);
  await symlink(outside, path.join(f.vault, ".trash"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.store.delete("note.md"), VaultPathError);
  assert.equal(await readFile(path.join(outside, "note.md"), "utf8"), "external");
  assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "inside");
  assert.deepEqual(await readdir(outside), ["note.md"]);
});

test("move/delete revalidation rejects a source parent replaced by a junction", async t => {
  for (const operation of ["move", "delete"] as const) {
    const f = await fixture(t);
    const parent = path.join(f.vault, "folder");
    const retired = path.join(f.vault, "retired");
    const outside = path.join(f.root, "outside");
    await mkdir(parent); await mkdir(outside);
    await writeFile(path.join(parent, "note.md"), "inside");
    await writeFile(path.join(outside, "note.md"), "outside");
    const resolve = f.sandbox.resolve.bind(f.sandbox);
    let swapped = false;
    f.sandbox.resolve = async (relative, options = {}) => {
      if (!swapped && relative === "folder/note.md" && options.mustExist) {
        swapped = true;
        await rename(parent, retired);
        await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
      }
      return resolve(relative, options);
    };
    await assert.rejects(operation === "move" ? f.store.move("folder/note.md", "moved.md") : f.store.delete("folder/note.md"), VaultPathError);
    assert.equal(await readFile(path.join(retired, "note.md"), "utf8"), "inside");
    assert.equal(await readFile(path.join(outside, "note.md"), "utf8"), "outside");
    assert.deepEqual(await readdir(outside), ["note.md"]);
  }
});

test("rename, unlink and cross-device failures preserve files and never trigger a copy or permanent fallback", async t => {
  for (const failure of ["EACCES", "EXDEV"]) {
    let calls = 0;
    const fault = async () => { calls++; throw errno(failure); };
    const f = await fixture(t, { ...nativeMutationIO, rename: fault, link: fault, unlink: fault });
    await writeFile(path.join(f.vault, "source.md"), "source");
    await writeFile(path.join(f.vault, "target.md"), "target");
    await assert.rejects(f.store.move("source.md", "new.md"), failure === "EXDEV" ? code("cross_device") : {code: failure});
    await assert.rejects(f.store.move("source.md", "target.md", { allowOverwrite: true }), failure === "EXDEV" ? code("cross_device") : {code: failure});
    await assert.rejects(f.store.delete("source.md"), failure === "EXDEV" ? code("cross_device") : {code: failure});
    await assert.rejects(f.store.delete("source.md", { permanent: true }), {code: failure});
    assert.equal(calls, 4);
    assert.equal(await readFile(path.join(f.vault, "source.md"), "utf8"), "source");
    assert.equal(await readFile(path.join(f.vault, "target.md"), "utf8"), "target");
    assert.deepEqual(await readdir(path.join(f.vault, ".trash")), []);
    await missing(path.join(f.vault, "new.md"));
  }
});

test("move locks both paths across stores while delete and write wait without stale retries", async t => {
  const entered = deferred(); const release = deferred();
  const f = await fixture(t, { ...nativeMutationIO, rename: async (a, b) => {
    entered.resolve(); await release.promise; await nativeMutationIO.rename(a, b);
  } });
  const other = await VaultMutationStore.create(f.sandbox);
  await writeFile(path.join(f.vault, "source.md"), "source");
  await writeFile(path.join(f.vault, "target.md"), "old target");
  const moving = f.store.move("source.md", "target.md", { allowOverwrite: true });
  await entered.promise;
  const waiting = Promise.allSettled([
    other.delete("source.md"),
    other.write("target.md", "stale", { ifMatch: computeContentVersion("old target") }),
  ]);
  release.resolve();
  await moving;
  const results = await waiting;
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  if (results[1]?.status === "rejected") assert.ok(results[1].reason instanceof VersionConflictError);
  assert.equal(await readFile(path.join(f.vault, "target.md"), "utf8"), "source");
  assert.deepEqual(await readdir(f.vault), ["target.md"]);
});

test("inverse moves and file-as-parent races terminate without nested-lock deadlock", {timeout: 5000}, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vault, "a.md"), "A");
  await writeFile(path.join(f.vault, "b.md"), "B");
  const inverse = await Promise.allSettled([f.store.move("a.md", "b.md"), f.store.move("b.md", "a.md")]);
  assert.ok(inverse.every(result => result.status === "rejected"));
  await assert.rejects(f.store.move("a.md", "a.md/child.md"));
  await mkdir(path.join(f.vault, "parent"));
  await writeFile(path.join(f.vault, "parent/child.md"), "child");
  const conflict = await Promise.allSettled([
    f.store.write("parent/child.md", "new", { ifMatch: computeContentVersion("child") }),
    f.store.move("parent/child.md", "parent", { allowOverwrite: true }),
  ]);
  assert.equal(conflict[0]?.status, "fulfilled");
  assert.equal(conflict[1]?.status, "rejected");
});
