import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { TextDecoder } from "node:util";
import { assertTextContent, assertTextPath } from "./text-policy.js";

import {
  VaultPathError,
  type VaultPathSandbox,
  type VaultRelativePath,
} from "../path/vault-path.js";
import {
  computeContentVersion,
  type ContentVersion,
} from "../version/content-version.js";

export const DEFAULT_MAX_VAULT_DOCUMENT_BYTES = 4 * 1024 * 1024;
/** Product policy shared by direct reads, document maps, and Markdown scans. */
export const MAX_VAULT_DOCUMENT_BYTES = 64 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;
const utf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export interface ReadVaultDocumentOptions {
  /** Inclusive exact-byte limit, from 0 through 64 MiB. Defaults to 4 MiB. */
  readonly maxBytes?: number;
}

export interface VaultDocumentReadResult {
  readonly content: string;
  /** Informational filesystem metadata; `version` is the concurrency token. */
  readonly modifiedAtMs: number;
  readonly createdAtMs?: number;
  readonly path: VaultRelativePath;
  readonly sizeBytes: number;
  readonly version: ContentVersion;
}

export type VaultDocumentReadErrorCode =
  | "changed_during_read"
  | "invalid_read_limit"
  | "invalid_utf8"
  | "not_found"
  | "not_regular_file"
  | "too_large";

export abstract class VaultDocumentReadError extends Error {
  abstract readonly code: VaultDocumentReadErrorCode;
  readonly inputPath: string;

  protected constructor(inputPath: string, message: string) {
    super(message);
    this.name = "VaultDocumentReadError";
    this.inputPath = inputPath;
  }
}

export class InvalidVaultDocumentReadLimitError extends VaultDocumentReadError {
  override readonly code = "invalid_read_limit";
  readonly maxBytes: number;

  constructor(inputPath: string, maxBytes: number) {
    super(
      inputPath,
      `maxBytes must be an integer from 0 through ${MAX_VAULT_DOCUMENT_BYTES}`,
    );
    this.name = "InvalidVaultDocumentReadLimitError";
    this.maxBytes = maxBytes;
  }
}

export class VaultDocumentNotFoundError extends VaultDocumentReadError {
  override readonly code = "not_found";

  constructor(inputPath: string) {
    super(inputPath, `Vault document does not exist: ${inputPath}`);
    this.name = "VaultDocumentNotFoundError";
  }
}

export type VaultEntryType =
  | "block_device"
  | "character_device"
  | "directory"
  | "fifo"
  | "socket"
  | "symbolic_link"
  | "unknown";

export class VaultDocumentNotRegularFileError extends VaultDocumentReadError {
  override readonly code = "not_regular_file";
  readonly actualType: VaultEntryType;

  constructor(inputPath: string, actualType: VaultEntryType) {
    super(
      inputPath,
      `Vault document must be a regular file; found ${actualType}: ${inputPath}`,
    );
    this.name = "VaultDocumentNotRegularFileError";
    this.actualType = actualType;
  }
}

export class VaultDocumentTooLargeError extends VaultDocumentReadError {
  override readonly code = "too_large";
  readonly maxBytes: number;
  readonly observedSizeBytes: bigint;

  constructor(inputPath: string, observedSizeBytes: bigint, maxBytes: number) {
    super(
      inputPath,
      `Vault document exceeds the ${maxBytes}-byte read limit: ${inputPath}`,
    );
    this.name = "VaultDocumentTooLargeError";
    this.maxBytes = maxBytes;
    this.observedSizeBytes = observedSizeBytes;
  }
}

export class InvalidVaultDocumentEncodingError extends VaultDocumentReadError {
  override readonly code = "invalid_utf8";
  readonly encoding = "utf-8";

  constructor(inputPath: string) {
    super(inputPath, `Vault document is not valid UTF-8: ${inputPath}`);
    this.name = "InvalidVaultDocumentEncodingError";
  }
}

export class VaultDocumentChangedDuringReadError extends VaultDocumentReadError {
  override readonly code = "changed_during_read";

  constructor(inputPath: string) {
    super(inputPath, `Vault document changed while it was being read: ${inputPath}`);
    this.name = "VaultDocumentChangedDuringReadError";
  }
}

/** Metadata from an opened, revalidated regular file; no host path is exposed. */
export interface VaultFileInfo {
  readonly path: VaultRelativePath;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
  readonly modifiedAtMs: number;
}

export interface VaultFileBytes extends VaultFileInfo {
  readonly bytes: Buffer;
  readonly version: ContentVersion;
}

/** Opens and checks read access without loading a large attachment into memory. */
export async function inspectVaultFile(sandbox: VaultPathSandbox, inputPath: string): Promise<VaultFileInfo> {
  return withVaultFile(sandbox, inputPath, async () => ({}));
}

/** Exact bytes, using the same path, file-handle and snapshot checks as text reads. */
export async function readVaultFileBytes(
  sandbox: VaultPathSandbox, inputPath: string, options: ReadVaultDocumentOptions = {},
): Promise<VaultFileBytes> {
  const maxBytes = resolveMaxBytes(inputPath, options.maxBytes);
  return withVaultFile(sandbox, inputPath, async (handle, stats) => {
    if (stats.size > BigInt(maxBytes)) throw new VaultDocumentTooLargeError(inputPath, stats.size, maxBytes);
    const bytes = await readBounded(handle, inputPath, maxBytes);
    return { bytes, version: computeContentVersion(bytes) };
  });
}

/** UTF-8 decoding preserves BOM/newlines; the version hashes the original bytes. */
export async function readVaultDocument(
  sandbox: VaultPathSandbox, inputPath: string, options: ReadVaultDocumentOptions = {},
): Promise<VaultDocumentReadResult> {
  const maxBytes = resolveMaxBytes(inputPath, options.maxBytes);
  sandbox.parse(inputPath);
  assertTextPath(inputPath);
  const { bytes, ...info } = await readVaultFileBytes(sandbox, inputPath, { maxBytes });
  let content: string;
  try { content = utf8Decoder.decode(bytes); }
  catch (error: unknown) {
    if (error instanceof TypeError) throw new InvalidVaultDocumentEncodingError(inputPath);
    throw error;
  }
  assertTextContent(inputPath, content);
  return Object.freeze({ ...info, content });
}

async function withVaultFile<T extends object>(
  sandbox: VaultPathSandbox, inputPath: string,
  read: (handle: FileHandle, stats: BigIntStats) => Promise<T>,
): Promise<T & VaultFileInfo> {
  const resolved = await resolveInitialPath(sandbox, inputPath);
  const initialPathStats = await lstatInitialPath(
    resolved.absolutePath,
    inputPath,
  );

  assertRegularFile(inputPath, initialPathStats);

  let handle: FileHandle;
  try {
    handle = await open(resolved.absolutePath, safeReadFlags());
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDocumentNotFoundError(inputPath);
    }

    if (isSymlinkLoopError(error)) {
      throw new VaultPathError(
        "symlink_traversal",
        inputPath,
        "Vault path became a symbolic link before it could be opened",
      );
    }

    throw error;
  }

  try {
    const beforeReadStats = await handle.stat({ bigint: true });
    assertRegularFile(inputPath, beforeReadStats);
    await assertPathStillReferencesHandle(
      sandbox,
      inputPath,
      resolved.absolutePath,
      beforeReadStats,
    );

    const result = await read(handle, beforeReadStats);
    const afterReadStats = await handle.stat({ bigint: true });

    if (!sameSnapshot(beforeReadStats, afterReadStats)) {
      throw new VaultDocumentChangedDuringReadError(inputPath);
    }

    await assertPathStillReferencesHandle(
      sandbox,
      inputPath,
      resolved.absolutePath,
      afterReadStats,
    );

    if (afterReadStats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new VaultDocumentTooLargeError(inputPath, afterReadStats.size, Number.MAX_SAFE_INTEGER);
    }
    return Object.freeze({ ...result,
      createdAtMs: Number(afterReadStats.birthtimeNs) / 1_000_000,
      modifiedAtMs: Number(afterReadStats.mtimeNs) / 1_000_000,
      path: resolved.relativePath,
      sizeBytes: Number(afterReadStats.size),
    });
  } finally {
    await handle.close();
  }
}

function resolveMaxBytes(inputPath: string, configuredMaxBytes: number | undefined): number {
  const maxBytes = configuredMaxBytes ?? DEFAULT_MAX_VAULT_DOCUMENT_BYTES;

  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MAX_VAULT_DOCUMENT_BYTES
  ) {
    throw new InvalidVaultDocumentReadLimitError(inputPath, maxBytes);
  }

  return maxBytes;
}

async function resolveInitialPath(
  sandbox: VaultPathSandbox,
  inputPath: string,
) {
  try {
    return await sandbox.resolve(inputPath, { mustExist: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDocumentNotFoundError(inputPath);
    }

    throw error;
  }
}

async function lstatInitialPath(
  absolutePath: string,
  inputPath: string,
): Promise<BigIntStats> {
  try {
    return await lstat(absolutePath, { bigint: true });
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDocumentNotFoundError(inputPath);
    }

    throw error;
  }
}

function assertRegularFile(inputPath: string, stats: BigIntStats): void {
  if (!stats.isFile()) {
    throw new VaultDocumentNotRegularFileError(
      inputPath,
      describeEntryType(stats),
    );
  }
}

async function assertPathStillReferencesHandle(
  sandbox: VaultPathSandbox,
  inputPath: string,
  absolutePath: string,
  handleStats: BigIntStats,
): Promise<void> {
  try {
    const current = await sandbox.resolve(inputPath, { mustExist: true });
    const pathStats = await lstat(current.absolutePath, { bigint: true });

    if (
      current.absolutePath !== absolutePath ||
      !pathStats.isFile() ||
      !sameFileIdentity(pathStats, handleStats)
    ) {
      throw new VaultDocumentChangedDuringReadError(inputPath);
    }
  } catch (error: unknown) {
    if (isMissingPathError(error)) {
      throw new VaultDocumentChangedDuringReadError(inputPath);
    }

    throw error;
  }
}

async function readBounded(
  handle: FileHandle,
  inputPath: string,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (totalBytes <= maxBytes) {
    const remainingWithSentinel = maxBytes + 1 - totalBytes;
    const chunk = Buffer.allocUnsafe(
      Math.min(READ_CHUNK_BYTES, remainingWithSentinel),
    );
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);

    if (bytesRead === 0) {
      break;
    }

    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }

  if (totalBytes > maxBytes) {
    throw new VaultDocumentTooLargeError(
      inputPath,
      BigInt(totalBytes),
      maxBytes,
    );
  }

  return Buffer.concat(chunks, totalBytes);
}

function safeReadFlags(): number {
  if (process.platform === "win32") {
    return constants.O_RDONLY;
  }

  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function describeEntryType(stats: BigIntStats): VaultEntryType {
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symbolic_link";
  if (stats.isBlockDevice()) return "block_device";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  return "unknown";
}

function isMissingPathError(error: unknown): boolean {
  return hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR");
}

function isSymlinkLoopError(error: unknown): boolean {
  return hasErrorCode(error, "ELOOP");
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === expectedCode
  );
}
