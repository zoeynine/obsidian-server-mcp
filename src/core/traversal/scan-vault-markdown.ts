import type { BigIntStats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import * as path from "node:path";

import {
  DEFAULT_MAX_VAULT_DOCUMENT_BYTES,
  MAX_VAULT_DOCUMENT_BYTES,
  VaultDocumentReadError,
  VaultDocumentTooLargeError,
  type ReadVaultDocumentOptions,
  type VaultDocumentReadResult,
} from "../file/read-vault-document.js";
import {
  VaultPathError,
  type VaultPathErrorCode,
  type VaultPathSandbox,
  type VaultRelativePath,
  parseVaultRelativePath,
} from "../path/vault-path.js";

const MEBIBYTE = 1024 * 1024;

export const DEFAULT_VAULT_MARKDOWN_SCAN_MAX_ENTRIES = 20_000;
export const DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILES = 5_000;
export const DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILE_BYTES = DEFAULT_MAX_VAULT_DOCUMENT_BYTES;
export const DEFAULT_VAULT_MARKDOWN_SCAN_MAX_TOTAL_BYTES = 64 * MEBIBYTE;
export const MAX_VAULT_MARKDOWN_SCAN_ENTRIES = 200_000;
export const MAX_VAULT_MARKDOWN_SCAN_FILES = 50_000;
export const MAX_VAULT_MARKDOWN_SCAN_FILE_BYTES = MAX_VAULT_DOCUMENT_BYTES;
export const MAX_VAULT_MARKDOWN_SCAN_TOTAL_BYTES = 1024 * MEBIBYTE;

export type VaultMarkdownScanBudgetName =
  | "maxEntries"
  | "maxFiles"
  | "maxTotalBytes";

export interface VaultMarkdownScanLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

export interface VaultMarkdownScanSkippedCounts {
  readonly nonMarkdownFiles: number;
  readonly nonRegularEntries: number;
  readonly symlinks: number;
}

export interface VaultMarkdownScanStats {
  readonly bytesRead: number;
  readonly directoriesVisited: number;
  readonly entriesVisited: number;
  readonly filesScanned: number;
  readonly skipped: VaultMarkdownScanSkippedCounts;
}

export type VaultMarkdownDocumentReader = (
  inputPath: string,
  options?: ReadVaultDocumentOptions,
) => Promise<VaultDocumentReadResult>;

export interface VaultMarkdownScanErrorFactory {
  readonly budgetExceeded: (
    budget: VaultMarkdownScanBudgetName,
    limit: number,
    observedAtLeast: bigint,
  ) => Error;
  readonly sourceUnavailable: (pathValue: string, osCode?: string) => Error;
  readonly traversalChanged: (pathValue: string) => Error;
  readonly traversalUnavailable: (pathValue: string, osCode?: string) => Error;
  readonly unsafeEntryName: (
    directory: string,
    entryName: string,
    reason: VaultPathErrorCode,
  ) => Error;
}

export type VaultMarkdownDocumentVisitor = (
  document: VaultDocumentReadResult,
) => Promise<void> | void;

interface ScanCandidate {
  readonly path: VaultRelativePath;
}

type TraversalEntryKind = "directory" | "file" | "other" | "symlink";

interface TraversalEntry {
  readonly kind: TraversalEntryKind;
  readonly path: VaultRelativePath;
}

interface TraversalState {
  directoriesVisited: number;
  entriesVisited: number;
  nonMarkdownFiles: number;
  nonRegularEntries: number;
  symlinks: number;
}

/**
 * Traverses and safely reads the regular Markdown files in a Vault scope once.
 *
 * Paths are visited in deterministic code-unit order. Symlinks and non-regular
 * entries are never followed. Callers own extraction semantics and supply the
 * public error vocabulary, while this primitive owns all filesystem behavior.
 */
export async function scanVaultMarkdownDocuments(
  sandbox: VaultPathSandbox,
  readDocument: VaultMarkdownDocumentReader,
  limits: VaultMarkdownScanLimits,
  errors: VaultMarkdownScanErrorFactory,
  visit: VaultMarkdownDocumentVisitor,
  scope: { readonly directory: string; readonly recursive: boolean } =
    { directory: "", recursive: true },
): Promise<VaultMarkdownScanStats> {
  const traversal = await collectVaultCandidates(sandbox, limits, errors, {
    ...scope, includeAttachments: false,
  });
  let bytesRead = 0;
  let filesScanned = 0;

  for (const candidate of traversal.candidates) {
    const remainingBytes = limits.maxTotalBytes - bytesRead;
    const readLimit = Math.min(limits.maxFileBytes, remainingBytes);
    let document: VaultDocumentReadResult;

    try {
      document = await readDocument(candidate.path, { maxBytes: readLimit });
    } catch (error: unknown) {
      if (
        error instanceof VaultDocumentTooLargeError &&
        readLimit === remainingBytes &&
        remainingBytes < limits.maxFileBytes
      ) {
        throw errors.budgetExceeded(
          "maxTotalBytes",
          limits.maxTotalBytes,
          BigInt(bytesRead) + error.observedSizeBytes,
        );
      }

      if (error instanceof VaultPathError || error instanceof VaultDocumentReadError) {
        throw error;
      }
      throw errors.sourceUnavailable(candidate.path, readOsCode(error));
    }

    if (document.path !== candidate.path) {
      throw errors.sourceUnavailable(candidate.path, "path_mismatch");
    }

    bytesRead += document.sizeBytes;
    if (bytesRead > limits.maxTotalBytes) {
      throw errors.budgetExceeded(
        "maxTotalBytes",
        limits.maxTotalBytes,
        BigInt(bytesRead),
      );
    }
    filesScanned += 1;
    await visit(document);
  }

  return Object.freeze({
    bytesRead,
    directoriesVisited: traversal.state.directoriesVisited,
    entriesVisited: traversal.state.entriesVisited,
    filesScanned,
    skipped: Object.freeze({
      nonMarkdownFiles: traversal.state.nonMarkdownFiles,
      nonRegularEntries: traversal.state.nonRegularEntries,
      symlinks: traversal.state.symlinks,
    }),
  });
}

/** Shared bounded inventory. Existing Markdown scans retain their root/recursive defaults. */
export async function collectVaultCandidates(
  sandbox: VaultPathSandbox,
  limits: VaultMarkdownScanLimits,
  errors: VaultMarkdownScanErrorFactory,
  scope: { directory: string; recursive: boolean; includeAttachments: boolean } =
    { directory: "", recursive: true, includeAttachments: false },
): Promise<{
  readonly candidates: readonly ScanCandidate[];
  readonly state: Readonly<TraversalState>;
  readonly directories: readonly VaultRelativePath[];
  readonly verify: () => Promise<void>;
}> {
  const candidates: ScanCandidate[] = [];
  const witnesses: { directory: VaultRelativePath; absolutePath: string; stats: BigIntStats }[] = [];
  const pendingDirectories: VaultRelativePath[] = [
    sandbox.parse(scope.directory, { allowRoot: true }),
  ];
  const state: TraversalState = {
    directoriesVisited: 0,
    entriesVisited: 0,
    nonMarkdownFiles: 0,
    nonRegularEntries: 0,
    symlinks: 0,
  };

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    const entries = await readDirectory(
      sandbox,
      directory,
      limits.maxEntries,
      state,
      errors,
      witnesses,
    );
    const childDirectories: VaultRelativePath[] = [];

    for (const entry of entries) {
      if (entry.kind === "directory") {
        if (scope.recursive) childDirectories.push(entry.path);
      } else if (entry.kind === "symlink") {
        state.symlinks += 1;
      } else if (entry.kind === "other") {
        state.nonRegularEntries += 1;
      } else if (scope.includeAttachments || isMarkdownPath(entry.path)) {
        if (candidates.length >= limits.maxFiles) {
          throw errors.budgetExceeded(
            "maxFiles",
            limits.maxFiles,
            BigInt(candidates.length + 1),
          );
        }
        candidates.push({ path: entry.path });
      } else {
        state.nonMarkdownFiles += 1;
      }
    }

    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]!);
    }
  }

  candidates.sort((left, right) => compareStrings(left.path, right.path));
  return {
    candidates: Object.freeze(candidates),
    state: Object.freeze({ ...state }),
    directories: Object.freeze(witnesses.map(witness => witness.directory)),
    verify: async () => {
      for (const witness of witnesses) {
        await assertDirectoryStillCurrent(sandbox, witness.directory, witness.absolutePath, witness.stats, errors);
        const stats = await lstatDirectory(witness.absolutePath, witness.directory, errors);
        if (!sameDirectorySnapshot(stats, witness.stats)) throw errors.traversalChanged(witness.directory);
      }
    },
  };
}

async function readDirectory(
  sandbox: VaultPathSandbox,
  directoryPath: VaultRelativePath,
  maxEntries: number,
  state: TraversalState,
  errors: VaultMarkdownScanErrorFactory,
  witnesses: { directory: VaultRelativePath; absolutePath: string; stats: BigIntStats }[],
): Promise<readonly TraversalEntry[]> {
  const resolved = await resolveDirectory(sandbox, directoryPath, errors);
  const beforeStats = await lstatDirectory(
    resolved.absolutePath,
    directoryPath,
    errors,
  );
  if (!beforeStats.isDirectory()) {
    throw errors.traversalChanged(directoryPath);
  }

  let directory;
  try {
    directory = await opendir(resolved.absolutePath);
  } catch (error: unknown) {
    if (isMissingPathError(error) || hasErrorCode(error, "ENOTDIR")) {
      throw errors.traversalChanged(directoryPath);
    }
    throw errors.traversalUnavailable(directoryPath, readOsCode(error));
  }

  const names: string[] = [];
  try {
    for (;;) {
      const dirent = await directory.read();
      if (dirent === null) break;
      if (state.entriesVisited >= maxEntries) {
        throw errors.budgetExceeded(
          "maxEntries",
          maxEntries,
          BigInt(state.entriesVisited + 1),
        );
      }
      state.entriesVisited += 1;
      names.push(dirent.name);
    }
  } finally {
    await directory.close();
  }

  names.sort(compareStrings);
  const entries: TraversalEntry[] = [];
  for (const name of names) {
    const childPath = toCanonicalPath(sandbox, directoryPath, name, errors);
    if (childPath === undefined) continue;
    const stats = await lstatEntry(
      path.join(resolved.absolutePath, name),
      directoryPath,
      errors,
    );
    entries.push(
      Object.freeze({
        kind: classifyEntry(stats),
        path: childPath,
      }),
    );
  }

  const afterStats = await lstatDirectory(
    resolved.absolutePath,
    directoryPath,
    errors,
  );
  if (!sameDirectorySnapshot(beforeStats, afterStats)) {
    throw errors.traversalChanged(directoryPath);
  }
  await assertDirectoryStillCurrent(
    sandbox,
    directoryPath,
    resolved.absolutePath,
    afterStats,
    errors,
  );
  state.directoriesVisited += 1;
  witnesses.push({ directory: directoryPath, absolutePath: resolved.absolutePath, stats: afterStats });

  return Object.freeze(entries);
}

async function resolveDirectory(
  sandbox: VaultPathSandbox,
  directoryPath: VaultRelativePath,
  errors: VaultMarkdownScanErrorFactory,
) {
  try {
    return await sandbox.resolve(directoryPath, {
      allowRoot: true,
      mustExist: true,
    });
  } catch (error: unknown) {
    if (error instanceof VaultPathError) throw error;
    if (isMissingPathError(error)) {
      throw errors.traversalChanged(directoryPath);
    }
    throw errors.traversalUnavailable(directoryPath, readOsCode(error));
  }
}

async function lstatDirectory(
  absolutePath: string,
  directoryPath: VaultRelativePath,
  errors: VaultMarkdownScanErrorFactory,
): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw errors.traversalChanged(directoryPath);
    }
    throw errors.traversalUnavailable(directoryPath, readOsCode(error));
  }
}

async function lstatEntry(
  absolutePath: string,
  directoryPath: VaultRelativePath,
  errors: VaultMarkdownScanErrorFactory,
): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw errors.traversalChanged(directoryPath);
    }
    throw errors.traversalUnavailable(directoryPath, readOsCode(error));
  }
}

async function assertDirectoryStillCurrent(
  sandbox: VaultPathSandbox,
  directoryPath: VaultRelativePath,
  absolutePath: string,
  expectedStats: BigIntStats,
  errors: VaultMarkdownScanErrorFactory,
): Promise<void> {
  let currentAbsolutePath: string;
  let currentStats: BigIntStats;
  try {
    const current = await sandbox.resolve(directoryPath, {
      allowRoot: true,
      mustExist: true,
    });
    currentAbsolutePath = current.absolutePath;
    currentStats = await lstat(current.absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (error instanceof VaultPathError) throw error;
    if (isMissingPathError(error)) {
      throw errors.traversalChanged(directoryPath);
    }
    throw errors.traversalUnavailable(directoryPath, readOsCode(error));
  }

  if (
    currentAbsolutePath !== absolutePath ||
    !currentStats.isDirectory() ||
    !sameFileIdentity(currentStats, expectedStats)
  ) {
    throw errors.traversalChanged(directoryPath);
  }
}

function toCanonicalPath(
  sandbox: VaultPathSandbox,
  directory: VaultRelativePath,
  entryName: string,
  errors: VaultMarkdownScanErrorFactory,
): VaultRelativePath | undefined {
  const candidate = directory.length === 0
    ? entryName
    : `${directory}/${entryName}`;
  try {
    return sandbox.discover(candidate);
  } catch (error: unknown) {
    if (error instanceof VaultPathError) {
      throw errors.unsafeEntryName(directory, entryName, error.code);
    }
    throw error;
  }
}

function classifyEntry(stats: BigIntStats): TraversalEntryKind {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function isMarkdownPath(filePath: VaultRelativePath): boolean {
  return filePath.toLowerCase().endsWith(".md");
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
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

function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

function readOsCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return readOsCode(error) === expectedCode;
}
