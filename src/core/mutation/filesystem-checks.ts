import type { BigIntStats } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import type { VaultPathSandbox, VaultRelativePath } from "../path/vault-path.js";
import { changed } from "./mutation-errors.js";

export interface DirectoryIdentity { readonly absolutePath: string; readonly stats: BigIntStats }
export function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
export function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function sameSnapshot(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid && a.nlink === b.nlink;
}
export function parentPath(relative: string): string { return relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ""; }

export async function checkDirectories(chain: readonly DirectoryIdentity[], relative: string): Promise<void> {
  for (const entry of chain) {
    const current = await lstat(entry.absolutePath, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(entry.stats, current)) throw changed(relative);
  }
}

/** Atomic mkdir of one checked component at a time. No nested path locks:
 * locking parents while holding file locks can invert move's two-file locks.
 * Concurrent mkdir is harmless; file-vs-directory races fail revalidation.
 */
export async function ensureParentDirectories(sandbox: VaultPathSandbox, relative: VaultRelativePath): Promise<DirectoryIdentity[]> {
  const root = await sandbox.resolve("", { allowRoot: true });
  const parents = [{ absolutePath: root.absolutePath, stats: await lstat(root.absolutePath, { bigint: true }) }];
  const segments = relative.split("/").slice(0, -1);
  for (let i = 1; i <= segments.length; i++) {
    await checkDirectories(parents, relative);
    const resolved = await sandbox.resolve(segments.slice(0, i).join("/"), { rejectNameAliases: true });
    try { await mkdir(resolved.absolutePath); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const stats = await lstat(resolved.absolutePath, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw changed(relative);
    parents.push({ absolutePath: resolved.absolutePath, stats });
  }
  return parents;
}
