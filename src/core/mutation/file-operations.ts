import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, rmdir } from "node:fs/promises";
import * as path from "node:path";
import type { VaultPathSandbox, VaultRelativePath } from "../path/vault-path.js";
import { MAX_VAULT_DOCUMENT_BYTES } from "../file/read-vault-document.js";
import { assertVersionMatch, parseContentVersion, type ContentVersion } from "../version/content-version.js";
import { withPathLock, withPathLocks } from "./path-lock.js";
import { checkDirectories, ensureParentDirectories, hasCode, parentPath, sameIdentity, sameSnapshot } from "./filesystem-checks.js";
import { changed, VaultMutationError } from "./mutation-errors.js";
import { nativeMutationIO, type MutationIO } from "./mutation-io.js";

export interface VaultDeleteOptions { readonly permanent?: boolean; readonly ifMatch?: string }
export type VaultDeleteResult = { readonly message: "OK"; readonly path: VaultRelativePath } & (
  { readonly permanent: true } | { readonly permanent: false; readonly trashPath: string });
export interface VaultMoveOptions { readonly allowOverwrite?: boolean; readonly ifMatch?: string }
export interface VaultMoveResult { readonly message: "OK"; readonly oldPath: VaultRelativePath; readonly newPath: VaultRelativePath }

/** Filesystem move with Local REST destination/overwrite semantics. The headless
 * backend cannot perform Desktop link/history updates. No copy fallback/retry.
 */
export async function moveVaultFile(sandbox: VaultPathSandbox, inputPath: string, destination: string,
  options: VaultMoveOptions = {}, io: MutationIO = nativeMutationIO): Promise<VaultMoveResult> {
  const source = sandbox.parse(inputPath);
  const target = sandbox.parseMoveDestination(source, destination);
  const ifMatch = options.ifMatch;
  const allowOverwrite = options.allowOverwrite ?? false;
  if (ifMatch !== undefined) parseContentVersion(ifMatch);
  return withPathLocks(sandbox.root, [source, target], async () => {
    // Upstream treats an identical path as a no-op, even if it is missing.
    // A supplied version still requires an existing matching regular file.
    if (source === target) {
      await sandbox.resolve(source, { rejectNameAliases: true });
      if (ifMatch !== undefined) await snapshot(sandbox, source, ifMatch);
      return { message: "OK", oldPath: source, newPath: target };
    }
    const initial = await snapshot(sandbox, source, ifMatch);
    const previousTarget = await optionalSnapshot(sandbox, target);
    if (previousTarget && !allowOverwrite) throw new VaultMutationError("destination_exists", "Destination already exists", { path: source, destination: target });
    const sourceParent = await sandbox.resolve(parentPath(source), { allowRoot: true, mustExist: true });
    const sourceParentStats = await lstat(sourceParent.absolutePath, { bigint: true });
    const targetParents = await ensureParentDirectories(sandbox, target);
    const finalSource = await snapshot(sandbox, source, ifMatch);
    if (!sameSnapshot(initial.stats, finalSource.stats)) throw changed(source);
    const currentTarget = await optionalSnapshot(sandbox, target);
    if (previousTarget ? !currentTarget || !sameSnapshot(previousTarget.stats, currentTarget.stats) : currentTarget !== undefined) throw changed(target);
    await sandbox.resolve(parentPath(source), { allowRoot: true, mustExist: true });
    if (!sameIdentity(sourceParentStats, await lstat(sourceParent.absolutePath, { bigint: true }))) throw changed(source);
    await checkDirectories(targetParents, target);
    const resolvedTarget = await sandbox.resolve(target, { rejectNameAliases: true });
    try {
      if (allowOverwrite) {
        // Rename replaces the destination atomically, without unlinking it first.
        await io.rename(finalSource.absolutePath, resolvedTarget.absolutePath);
      } else {
        // Node exposes no rename-NOREPLACE. Link atomically refuses a raced-in
        // destination; unlink the source only after revalidating both names.
        await io.link(finalSource.absolutePath, resolvedTarget.absolutePath);
        try {
          const linked = await snapshot(sandbox, source, ifMatch, 2n);
          if (!sameIdentity(initial.stats, linked.stats) || initial.stats.size !== linked.stats.size ||
              initial.stats.mtimeNs !== linked.stats.mtimeNs || initial.stats.mode !== linked.stats.mode ||
              initial.stats.uid !== linked.stats.uid || initial.stats.gid !== linked.stats.gid) throw changed(source);
          await checkDirectories(targetParents, target);
          await sandbox.resolve(target, { mustExist: true, rejectNameAliases: true });
          if (!sameIdentity(initial.stats, await lstat(resolvedTarget.absolutePath, { bigint: true }))) throw changed(target);
          await sandbox.resolve(parentPath(source), { allowRoot: true, mustExist: true });
          if (!sameIdentity(sourceParentStats, await lstat(sourceParent.absolutePath, { bigint: true }))) throw changed(source);
          await io.unlink(finalSource.absolutePath);
        } catch (error) {
          // A denied source unlink must not silently turn a move into a copy.
          // Roll back only our destination link, and only while source still
          // names the same inode. Never remove the sole remaining copy.
          try {
            await sandbox.resolve(source, { mustExist: true, rejectNameAliases: true });
            await sandbox.resolve(target, { mustExist: true, rejectNameAliases: true });
            await checkDirectories(targetParents, target);
            if (!sameIdentity(initial.stats, await lstat(finalSource.absolutePath, { bigint: true })) ||
                !sameIdentity(initial.stats, await lstat(resolvedTarget.absolutePath, { bigint: true }))) throw changed(target);
            await io.unlink(resolvedTarget.absolutePath);
          } catch (cleanupError) {
            throw new VaultMutationError("source_cleanup_failed", "Move cleanup could not finish; inspect source and destination before retrying", { path: source, destination: target }, { cause: new AggregateError([error, cleanupError]) });
          }
          throw error;
        }
      }
    } catch (error) {
      if (hasCode(error, "EEXIST")) throw new VaultMutationError("destination_exists", "Destination already exists", { path: source, destination: target });
      if (hasCode(error, "EXDEV")) throw new VaultMutationError("cross_device", "Move requires the same filesystem; no copy fallback", { path: source, destination: target }, { cause: error });
      throw error;
    }
    return { message: "OK", oldPath: source, newPath: target };
  });
}

/** Local REST naming/flags, with server-local recoverable trash by default.
 * Works on regular files including attachments: no text decoding or transfer.
 * ifMatch is an optional exact-byte extension; omission retains Local REST's
 * delete-current-path behavior. No automatic retry or link/backlink rewriting.
 */
export async function deleteVaultFile(sandbox: VaultPathSandbox, inputPath: string,
  options: VaultDeleteOptions = {}, io: MutationIO = nativeMutationIO): Promise<VaultDeleteResult> {
  const relative = sandbox.parse(inputPath);
  const permanent = options.permanent ?? false;
  const ifMatch = options.ifMatch;
  if (ifMatch !== undefined) parseContentVersion(ifMatch);
  return withPathLock(sandbox.root, relative, async () => {
    const initial = await snapshot(sandbox, relative, ifMatch);
    const parentRelative = parentPath(relative);
    const parent = await sandbox.resolve(parentRelative, { allowRoot: true });
    const parentStats = await lstat(parent.absolutePath, { bigint: true });
    let bucket: { relative: string; absolute: string; stats: BigIntStats } | undefined;
    let trashPath: string | undefined;
    let destination: string | undefined;
    let moved = false;
    try {
      if (!permanent) {
        const trash = await sandbox.resolveInternalTrash();
        try { await mkdir(trash.absolutePath); }
        catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
        const checkedTrash = await sandbox.resolveInternalTrash("", { mustExist: true });
        if (!(await lstat(checkedTrash.absolutePath)).isDirectory()) {
          throw new VaultMutationError("trash_unavailable", "Vault trash must be a real directory", { path: relative });
        }
        // An exclusive, unique directory reserves the destination namespace.
        // Preserve the filename; the receipt records source and recovery path.
        const bucketName = `${Date.now()}-${randomUUID()}`;
        const resolvedBucket = await sandbox.resolveInternalTrash(bucketName);
        await mkdir(resolvedBucket.absolutePath);
        bucket = { relative: bucketName, absolute: resolvedBucket.absolutePath,
          stats: await lstat(resolvedBucket.absolutePath, { bigint: true }) };
        const trashRelative = `${bucketName}/${path.posix.basename(relative)}`;
        const target = await sandbox.resolveInternalTrash(trashRelative);
        trashPath = target.relativePath;
        destination = target.absolutePath;
      }
      // Recheck source after trash preparation; byte preconditions, when given,
      // are evaluated again immediately before publication/removal.
      const finalParent = await sandbox.resolve(parentRelative, { allowRoot: true, mustExist: true });
      if (!sameIdentity(parentStats, await lstat(finalParent.absolutePath, { bigint: true }))) throw changed(relative);
      if (bucket) {
        await sandbox.resolveInternalTrash(bucket.relative, { mustExist: true });
        if (!sameIdentity(bucket.stats, await lstat(bucket.absolute, { bigint: true }))) throw changed(relative);
      }
      const current = await snapshot(sandbox, relative, ifMatch);
      if (!sameSnapshot(initial.stats, current.stats)) throw changed(relative);
      if (permanent) await io.unlink(current.absolutePath);
      else {
        try { await io.rename(current.absolutePath, destination!); }
        catch (error) {
          if (hasCode(error, "EXDEV")) throw new VaultMutationError("cross_device", "Recoverable deletion requires Vault trash on the same filesystem; no copy fallback", { path: relative }, { cause: error });
          throw error;
        }
        moved = true;
      }
      return permanent ? { message: "OK", path: relative, permanent: true } :
        { message: "OK", path: relative, permanent: false, trashPath: trashPath! };
    } finally {
      if (bucket && !moved) {
        // Remove only this empty reservation, never a recursive trash tree.
        // A failed cleanup can leave an empty protected directory; it cannot
        // change the source note or turn a failed move into a successful one.
        try {
          await sandbox.resolveInternalTrash(bucket.relative, { mustExist: true });
          if (sameIdentity(bucket.stats, await lstat(bucket.absolute, { bigint: true }))) await rmdir(bucket.absolute);
        } catch { /* Empty trash reservation is harmless; original error wins. */ }
      }
    }
  });
}

async function optionalSnapshot(sandbox: VaultPathSandbox, relative: VaultRelativePath) {
  try { return await snapshot(sandbox, relative, undefined); }
  catch (error) { if (error instanceof VaultMutationError && error.code === "not_found") return undefined; throw error; }
}

async function snapshot(sandbox: VaultPathSandbox, relative: VaultRelativePath, ifMatch: string | undefined, links = 1n) {
  const resolved = await sandbox.resolve(relative, { rejectNameAliases: true });
  let stats: BigIntStats;
  try { stats = await lstat(resolved.absolutePath, { bigint: true }); }
  catch (error) {
    if (hasCode(error, "ENOENT")) throw new VaultMutationError("not_found", "Vault file does not exist", { path: relative });
    throw error;
  }
  if (!stats.isFile() || stats.nlink !== links) throw new VaultMutationError("unsafe_target", "Operation requires a regular file without additional hard links; folders are not supported", { path: relative });
  if (ifMatch !== undefined) {
    if (stats.size > BigInt(MAX_VAULT_DOCUMENT_BYTES)) throw new VaultMutationError("too_large", "Version-checked file operations are limited to 64 MiB", { path: relative });
    const handle = await open(resolved.absolutePath, constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
    try {
      if (!sameSnapshot(stats, await handle.stat({ bigint: true }))) throw changed(relative);
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > MAX_VAULT_DOCUMENT_BYTES) throw new VaultMutationError("too_large", "Version-checked file operations are limited to 64 MiB", { path: relative });
        hash.update(chunk.subarray(0, bytesRead));
      }
      if (!sameSnapshot(stats, await handle.stat({ bigint: true }))) throw changed(relative);
      assertVersionMatch(`sha256:${hash.digest("hex")}` as ContentVersion, ifMatch);
    } finally { await handle.close(); }
  }
  await sandbox.resolve(relative, { mustExist: true, rejectNameAliases: true });
  if (!sameSnapshot(stats, await lstat(resolved.absolutePath, { bigint: true }))) throw changed(relative);
  return { absolutePath: resolved.absolutePath, stats };
}
