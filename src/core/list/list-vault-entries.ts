import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import * as path from "node:path";

import {
  VaultPathError,
  type VaultPathErrorCode,
  type VaultPathSandbox,
  type VaultRelativePath,
} from "../path/vault-path.js";

export const DEFAULT_MAX_VAULT_LIST_ENTRIES = 1_000;
export const MAX_VAULT_LIST_ENTRIES = 10_000;

export interface ListVaultEntriesOptions {
  /** Maximum entries accepted from one directory. Defaults to 1,000. */
  readonly maxEntries?: number;
}

export type VaultListEntryKind = "directory" | "file" | "other" | "symlink";

export interface VaultListEntry {
  readonly kind: VaultListEntryKind;
  readonly name: string;
  readonly path: VaultRelativePath;
}

export interface VaultListResult {
  readonly directory: VaultRelativePath;
  readonly entries: readonly VaultListEntry[];
}

export type VaultListErrorCode =
  | "changed_during_list"
  | "entry_name_not_representable"
  | "invalid_list_limit"
  | "not_directory"
  | "not_found"
  | "too_many_entries";

export abstract class VaultListError extends Error {
  abstract readonly code: VaultListErrorCode;
  readonly inputPath: string;

  protected constructor(inputPath: string, message: string) {
    super(message);
    this.name = "VaultListError";
    this.inputPath = inputPath;
  }
}

export class InvalidVaultListLimitError extends VaultListError {
  override readonly code = "invalid_list_limit";
  readonly maxEntries: number;

  constructor(inputPath: string, maxEntries: number) {
    super(
      inputPath,
      `maxEntries must be an integer from 1 through ${MAX_VAULT_LIST_ENTRIES}`,
    );
    this.name = "InvalidVaultListLimitError";
    this.maxEntries = maxEntries;
  }
}

export class VaultDirectoryNotFoundError extends VaultListError {
  override readonly code = "not_found";

  constructor(inputPath: string) {
    super(inputPath, `Vault directory does not exist: ${displayPath(inputPath)}`);
    this.name = "VaultDirectoryNotFoundError";
  }
}

export class VaultListNotDirectoryError extends VaultListError {
  override readonly code = "not_directory";

  constructor(inputPath: string) {
    super(inputPath, `Vault list target is not a directory: ${displayPath(inputPath)}`);
    this.name = "VaultListNotDirectoryError";
  }
}

export class VaultDirectoryTooLargeError extends VaultListError {
  override readonly code = "too_many_entries";
  readonly maxEntries: number;
  readonly observedAtLeast: number;

  constructor(inputPath: string, observedAtLeast: number, maxEntries: number) {
    super(
      inputPath,
      `Vault directory exceeds the ${maxEntries}-entry list limit: ${displayPath(inputPath)}`,
    );
    this.name = "VaultDirectoryTooLargeError";
    this.maxEntries = maxEntries;
    this.observedAtLeast = observedAtLeast;
  }
}

export class VaultEntryNameNotRepresentableError extends VaultListError {
  override readonly code = "entry_name_not_representable";
  readonly entryName: string;
  readonly reason: VaultPathErrorCode;

  constructor(
    inputPath: string,
    entryName: string,
    reason: VaultPathErrorCode,
  ) {
    super(
      inputPath,
      `Vault entry cannot be represented as a canonical path: ${entryName}`,
    );
    this.name = "VaultEntryNameNotRepresentableError";
    this.entryName = entryName;
    this.reason = reason;
  }
}

export class VaultDirectoryChangedDuringListError extends VaultListError {
  override readonly code = "changed_during_list";

  constructor(inputPath: string) {
    super(
      inputPath,
      `Vault directory changed while it was being listed: ${displayPath(inputPath)}`,
    );
    this.name = "VaultDirectoryChangedDuringListError";
  }
}

/**
 * Lists one directory without following child symbolic links.
 *
 * The operation returns the whole sorted directory or a typed limit error. It
 * never returns a partial page and keeps no cursor or snapshot state. Symlink
 * entries are visible as `kind: "symlink"`, but listing through one remains
 * prohibited by {@link VaultPathSandbox}.
 */
export async function listVaultEntries(
  sandbox: VaultPathSandbox,
  inputPath = "",
  options: ListVaultEntriesOptions = {},
): Promise<VaultListResult> {
  const maxEntries = resolveMaxEntries(inputPath, options.maxEntries);
  const resolved = await resolveInitialDirectory(sandbox, inputPath);
  const beforeListStats = await lstatInitialDirectory(
    resolved.absolutePath,
    inputPath,
  );

  assertDirectory(inputPath, beforeListStats);

  let directory;
  try {
    directory = await opendir(resolved.absolutePath);
  } catch (error: unknown) {
    if (isMissingPathError(error) || hasErrorCode(error, "ENOTDIR")) {
      throw new VaultDirectoryChangedDuringListError(inputPath);
    }

    throw error;
  }

  const entries: VaultListEntry[] = [];
  let observedEntries = 0;

  try {
    for (;;) {
      const dirent = await directory.read();
      if (dirent === null) break;

      if (observedEntries++ >= maxEntries) {
        throw new VaultDirectoryTooLargeError(
          inputPath,
          maxEntries + 1,
          maxEntries,
        );
      }

      const entryPath = toCanonicalEntryPath(
        sandbox,
        resolved.relativePath,
        dirent.name,
        inputPath,
      );
      if (entryPath === undefined) continue;
      const entryStats = await lstatEntry(
        path.join(resolved.absolutePath, dirent.name),
        inputPath,
      );

      entries.push(
        Object.freeze({
          kind: classifyEntry(entryStats),
          name: dirent.name,
          path: entryPath,
        }),
      );
    }
  } finally {
    await directory.close();
  }

  const afterListStats = await lstatCurrentDirectory(
    resolved.absolutePath,
    inputPath,
  );

  if (!sameDirectorySnapshot(beforeListStats, afterListStats)) {
    throw new VaultDirectoryChangedDuringListError(inputPath);
  }

  await assertDirectoryPathStillCurrent(
    sandbox,
    inputPath,
    resolved.absolutePath,
    afterListStats,
  );

  entries.sort(compareEntries);

  return Object.freeze({
    directory: resolved.relativePath,
    entries: Object.freeze(entries),
  });
}

/** Public Local REST projection; filesystem classification stays in core. */
export async function listVaultFiles(sandbox: VaultPathSandbox, path = "", options: ListVaultEntriesOptions = {}): Promise<{ files: readonly string[] }> {
  // Local REST accepts a directory suffix. Strip exactly one, never a root /
  // or arbitrary separators; the shared sandbox still rejects unsafe input.
  const directory = path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
  const result = await listVaultEntries(sandbox, directory, options);
  return { files: result.entries.filter((entry) => entry.kind === "file" || entry.kind === "directory")
    .map((entry) => entry.name + (entry.kind === "directory" ? "/" : "")) };
}

function resolveMaxEntries(
  inputPath: string,
  configuredMaxEntries: number | undefined,
): number {
  const maxEntries = configuredMaxEntries ?? DEFAULT_MAX_VAULT_LIST_ENTRIES;

  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > MAX_VAULT_LIST_ENTRIES
  ) {
    throw new InvalidVaultListLimitError(inputPath, maxEntries);
  }

  return maxEntries;
}

async function resolveInitialDirectory(
  sandbox: VaultPathSandbox,
  inputPath: string,
) {
  try {
    return await sandbox.resolve(inputPath, {
      allowRoot: true,
      mustExist: true,
    });
  } catch (error: unknown) {
    if (isMissingPathError(error) || hasErrorCode(error, "ENOTDIR")) {
      throw new VaultDirectoryNotFoundError(inputPath);
    }

    throw error;
  }
}

async function lstatInitialDirectory(
  absolutePath: string,
  inputPath: string,
): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error) || hasErrorCode(error, "ENOTDIR")) {
      throw new VaultDirectoryNotFoundError(inputPath);
    }

    throw error;
  }
}

async function lstatEntry(
  absolutePath: string,
  inputPath: string,
): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDirectoryChangedDuringListError(inputPath);
    }

    throw error;
  }
}

async function lstatCurrentDirectory(
  absolutePath: string,
  inputPath: string,
): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDirectoryChangedDuringListError(inputPath);
    }

    throw error;
  }
}

function assertDirectory(inputPath: string, stats: BigIntStats): void {
  if (!stats.isDirectory()) {
    throw new VaultListNotDirectoryError(inputPath);
  }
}

async function assertDirectoryPathStillCurrent(
  sandbox: VaultPathSandbox,
  inputPath: string,
  absolutePath: string,
  expectedStats: BigIntStats,
): Promise<void> {
  try {
    const current = await sandbox.resolve(inputPath, {
      allowRoot: true,
      mustExist: true,
    });
    const currentStats = await lstat(current.absolutePath, { bigint: true });

    if (
      current.absolutePath !== absolutePath ||
      !currentStats.isDirectory() ||
      !sameFileIdentity(currentStats, expectedStats)
    ) {
      throw new VaultDirectoryChangedDuringListError(inputPath);
    }
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDirectoryChangedDuringListError(inputPath);
    }

    throw error;
  }
}

function toCanonicalEntryPath(
  sandbox: VaultPathSandbox,
  directory: VaultRelativePath,
  entryName: string,
  inputPath: string,
): VaultRelativePath | undefined {
  const candidate = directory.length === 0 ? entryName : `${directory}/${entryName}`;

  try {
    return sandbox.discover(candidate);
  } catch (error: unknown) {
    if (error instanceof VaultPathError) {
      throw new VaultEntryNameNotRepresentableError(
        inputPath,
        entryName,
        error.code,
      );
    }

    throw error;
  }
}

function classifyEntry(stats: BigIntStats): VaultListEntryKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function compareEntries(left: VaultListEntry, right: VaultListEntry): number {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectorySnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function displayPath(inputPath: string): string {
  return inputPath.length === 0 ? "<vault-root>" : inputPath;
}

function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT");
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === expectedCode
  );
}
