import * as assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { VaultDocumentNotFoundError } from "../../src/core/file/read-vault-document.js";
import { nativeMutationIO, type MutationIO } from "../../src/core/mutation/mutation-io.js";
import { VaultMutationError, VaultMutationStore } from "../../src/core/mutation/vault-mutations.js";
import { VaultPathSandbox } from "../../src/core/path/vault-path.js";
import {
  ConflictingVersionPreconditionsError,
  InvalidContentVersionError,
  InvalidVersionGuardError,
  VersionConflictError,
  VersionGuardConflictError,
  assertVersionMatch,
  assertVersionPrecondition,
  computeContentVersion,
  getVersionGuard,
  parseContentVersion,
  parseVersionGuard,
  parseVersionPrecondition,
  type VersionPreconditionInput,
} from "../../src/core/version/content-version.js";

const original = "\uFEFF# Title\r\nold\r\n";
const version = computeContentVersion(original);
const guard = getVersionGuard(version);
const operations = ["write", "append", "patch", "replaceText", "move", "delete"] as const;
type Operation = typeof operations[number];

async function fixture(t: TestContext, io: MutationIO = nativeMutationIO) {
  const temporary = path.resolve(".test-dist", ".test-tmp");
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(path.join(temporary, "obsidian-version-guard-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  t.after(() => rm(root, { recursive: true, force: true }));
  const sandbox = await VaultPathSandbox.create(vault);
  const store = await VaultMutationStore.create(sandbox, { io });
  return { vault, sandbox, store };
}

function patchInstruction(precondition: VersionPreconditionInput) {
  return { targetType: "heading", target: ["Title"], operation: "replace", scope: "marker", content: "Renamed", ...precondition };
}

function mutate(store: VaultMutationStore, operation: Operation, precondition: VersionPreconditionInput,
  inputPath = "note.md"): Promise<unknown> {
  switch (operation) {
    case "write": return store.write(inputPath, "new", precondition);
    case "append": return store.append(inputPath, "new", precondition);
    case "patch": return store.patch(inputPath, patchInstruction(precondition));
    case "replaceText": return store.replaceText(inputPath, "old", "new", precondition);
    case "move": return store.move(inputPath, "moved.md", precondition);
    case "delete": return store.delete(inputPath, precondition);
  }
}

async function assertSaved(vault: string, operation: Operation, result: unknown): Promise<void> {
  if (operation === "delete") {
    assert.ok(result && typeof result === "object" && "trashPath" in result);
    assert.equal(typeof result.trashPath, "string");
    assert.deepEqual(await readFile(path.join(vault, result.trashPath as string)), Buffer.from(original));
    await assert.rejects(lstat(path.join(vault, "note.md")), { code: "ENOENT" });
    return;
  }
  const savedPath = operation === "move" ? "moved.md" : "note.md";
  const expected = operation === "write" ? "new" : operation === "append" ? original + "new"
    : operation === "patch" ? original.replace("Title", "Renamed") : operation === "replaceText"
      ? original.replace("old", "new") : original;
  const saved = await readFile(path.join(vault, savedPath));
  assert.deepEqual(saved, Buffer.from(expected));
  if (operation === "move") await assert.rejects(lstat(path.join(vault, "note.md")), { code: "ENOENT" });
  else {
    assert.ok(result && typeof result === "object" && "version" in result);
    assert.equal(result.version, computeContentVersion(saved));
    assert.ok("versionGuard" in result);
    assert.equal(result.versionGuard, getVersionGuard(computeContentVersion(saved)));
  }
  assert.deepEqual(await readdir(vault), [savedPath]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("versionGuard is the fixed 16 lowercase hex prefix of the exact-byte version", () => {
  assert.equal(getVersionGuard(computeContentVersion("hello")), "2cf24dba5fb0a30e");
  assert.equal(getVersionGuard(computeContentVersion(Buffer.from(original))), guard);
  assert.equal(guard, version.slice(7, 23));
  assert.match(guard, /^[0-9a-f]{16}$/u);
  assert.notEqual(getVersionGuard(computeContentVersion(original.slice(1))), guard);
  assert.notEqual(getVersionGuard(computeContentVersion(original.replace(/\r\n/gu, "\n"))), guard);
});

test("guard parsing accepts exactly 16 lowercase hex characters without prefix or whitespace", () => {
  assert.equal(parseVersionGuard("0123456789abcdef"), "0123456789abcdef");
  for (const invalid of ["", "0".repeat(15), "0".repeat(17), "0".repeat(32), "0".repeat(64),
    "0123456789abcdeF", "0123456789abcdeg", " " + guard, guard + " ", guard + "\n", guard + "\r\n", "sha256:" + guard, version]) {
    assert.throws(() => parseVersionGuard(invalid), (error: unknown) =>
      error instanceof InvalidVersionGuardError && error.value === invalid);
  }
  assert.throws(() => parseContentVersion(guard), InvalidContentVersionError);
  assert.throws(() => assertVersionMatch(version, guard), InvalidContentVersionError);
});

test("two different full versions can share a guard while full ifMatch still distinguishes them", () => {
  const first = parseContentVersion("sha256:" + "a".repeat(16) + "1".repeat(48));
  const second = parseContentVersion("sha256:" + "a".repeat(16) + "2".repeat(48));
  assert.notEqual(first, second);
  assert.equal(getVersionGuard(first), getVersionGuard(second));
  const precondition = parseVersionPrecondition({ ifMatchGuard: getVersionGuard(first) });
  assert.ok(precondition);
  assert.doesNotThrow(() => assertVersionPrecondition(second, precondition));
  assert.throws(() => assertVersionMatch(second, first), (error: unknown) =>
    error instanceof VersionConflictError && error.expected === first && error.actual === second);
});

test("all six mutations accept a current short guard and retain exact file bytes and full versions", async t => {
  for (const operation of operations) await t.test(operation, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.vault, "note.md"), original);
    await assertSaved(f.vault, operation, await mutate(f.store, operation, { ifMatchGuard: guard }));
  });
});

test("invalid, stale, wrong and dual preconditions never stage or publish any of the six mutations", async t => {
  const stale = getVersionGuard(computeContentVersion("stale"));
  const wrong = "0000000000000000";
  assert.notEqual(stale, guard);
  assert.notEqual(wrong, guard);
  const cases = [
    { name: "stale", options: { ifMatchGuard: stale }, error: VersionGuardConflictError },
    { name: "wrong", options: { ifMatchGuard: wrong }, error: VersionGuardConflictError },
    { name: "short", options: { ifMatchGuard: "0".repeat(15) }, error: InvalidVersionGuardError },
    { name: "long", options: { ifMatchGuard: "0".repeat(17) }, error: InvalidVersionGuardError },
    { name: "full hex as guard", options: { ifMatchGuard: version.slice(7) }, error: InvalidVersionGuardError },
    { name: "guard in old ifMatch", options: { ifMatch: guard }, error: InvalidContentVersionError },
    { name: "matching dual", options: { ifMatch: version, ifMatchGuard: guard }, error: ConflictingVersionPreconditionsError },
    { name: "inconsistent dual", options: { ifMatch: version, ifMatchGuard: stale }, error: ConflictingVersionPreconditionsError },
  ];
  for (const operation of operations) await t.test(operation, async t => {
    let writes = 0; let publishes = 0;
    const f = await fixture(t, { ...nativeMutationIO,
      writeFile: async (handle, bytes) => { writes++; await nativeMutationIO.writeFile(handle, bytes); },
      rename: async (from, to) => { publishes++; await nativeMutationIO.rename(from, to); },
      link: async (from, to) => { publishes++; await nativeMutationIO.link(from, to); },
      unlink: async filename => { publishes++; await nativeMutationIO.unlink(filename); },
    });
    await writeFile(path.join(f.vault, "note.md"), original);
    for (const c of cases) await t.test(c.name, async () => {
      await assert.rejects(mutate(f.store, operation, c.options), (error: unknown) => {
        assert.ok(error instanceof c.error);
        if (error instanceof VersionGuardConflictError) {
          assert.equal(error.expected, c.options.ifMatchGuard);
          assert.equal(error.actual, guard);
        }
        return true;
      });
      assert.equal(writes, 0);
      assert.equal(publishes, 0);
      assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(original));
      assert.deepEqual(await readdir(f.vault), ["note.md"]);
    });
  });
});

test("short guards preserve missing-target errors and never create a guarded target", async t => {
  for (const operation of operations) await t.test(operation, async t => {
    let writes = 0;
    const f = await fixture(t, { ...nativeMutationIO,
      writeFile: async (handle, bytes) => { writes++; await nativeMutationIO.writeFile(handle, bytes); },
    });
    await assert.rejects(mutate(f.store, operation, { ifMatchGuard: guard }, "nested/missing.md"), (error: unknown) => {
      if (operation === "patch" || operation === "replaceText") return error instanceof VaultDocumentNotFoundError;
      return error instanceof VaultMutationError && error.code ===
        (operation === "write" || operation === "append" ? "version_conflict" : "not_found");
    });
    assert.equal(writes, 0);
    assert.deepEqual(await readdir(f.vault), []);
    if (operation === "write" || operation === "append") {
      await mutate(f.store, operation, {}, "note.md");
      assert.equal(await readFile(path.join(f.vault, "note.md"), "utf8"), "new");
      assert.equal(writes, 1);
    }
  });
});

test("patch and replacement still require one precondition before staging", async t => {
  for (const operation of ["patch", "replaceText"] as const) await t.test(operation, async t => {
    let writes = 0;
    const f = await fixture(t, { ...nativeMutationIO,
      writeFile: async (handle, bytes) => { writes++; await nativeMutationIO.writeFile(handle, bytes); },
    });
    await writeFile(path.join(f.vault, "note.md"), original);
    await assert.rejects(mutate(f.store, operation, {}), (error: unknown) =>
      error instanceof VaultMutationError && error.code === "if_match_required");
    assert.equal(writes, 0);
    assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(original));
    assert.deepEqual(await readdir(f.vault), ["note.md"]);
  });
});

test("same-path move validates supplied guards before returning OK", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.vault, "note.md"), original);
  assert.deepEqual(await f.store.move("note.md", "note.md", { ifMatchGuard: guard }), {
    message: "OK", oldPath: "note.md", newPath: "note.md",
  });
  await assert.rejects(f.store.move("note.md", "note.md", { ifMatchGuard: getVersionGuard(computeContentVersion("stale")) }), VersionGuardConflictError);
  await assert.rejects(f.store.move("note.md", "note.md", { ifMatchGuard: "0".repeat(15) }), InvalidVersionGuardError);
  await assert.rejects(f.store.move("note.md", "note.md", { ifMatch: version, ifMatchGuard: guard }), ConflictingVersionPreconditionsError);
  await assert.rejects(f.store.move("missing.md", "missing.md", { ifMatchGuard: guard }), (error: unknown) =>
    error instanceof VaultMutationError && error.code === "not_found");
  assert.deepEqual(await f.store.move("missing.md", "missing.md"), {
    message: "OK", oldPath: "missing.md", newPath: "missing.md",
  });
  assert.deepEqual(await readFile(path.join(f.vault, "note.md")), Buffer.from(original));
  assert.deepEqual(await readdir(f.vault), ["note.md"]);
});

test("guard inputs are captured synchronously before another store releases the path lock", async t => {
  for (const operation of ["write", "append", "patch", "move", "delete"] as const) await t.test(operation, async t => {
    const entered = deferred(); const release = deferred();
    let pause = true;
    const f = await fixture(t, { ...nativeMutationIO, writeFile: async (handle, bytes) => {
      await nativeMutationIO.writeFile(handle, bytes);
      if (pause) { pause = false; entered.resolve(); await release.promise; }
    } });
    const second = await VaultMutationStore.create(f.sandbox);
    await writeFile(path.join(f.vault, "note.md"), "before lock");
    const first = f.store.write("note.md", original, { ifMatch: computeContentVersion("before lock") });
    let pending: Promise<unknown> | undefined;
    try {
      await entered.promise;
      const options = { ifMatchGuard: guard as string };
      const input = operation === "patch" ? patchInstruction(options) : options;
      pending = operation === "patch" ? second.patch("note.md", input) : mutate(second, operation, options);
      Object.assign(input, { ifMatchGuard: "changed after invocation", ifMatch: "added after invocation", content: "changed after invocation" });
    } finally { release.resolve(); }
    await first;
    assert.ok(pending);
    await assertSaved(f.vault, operation, await pending);
  });
});
