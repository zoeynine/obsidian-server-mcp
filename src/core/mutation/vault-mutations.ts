import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { Warning } from "markdown-patch";
import { requireJson } from "../document/note-json.js";
import { readVaultDocument, VaultDocumentNotFoundError, DEFAULT_MAX_VAULT_DOCUMENT_BYTES,
  MAX_VAULT_DOCUMENT_BYTES, type VaultDocumentReadResult } from "../file/read-vault-document.js";
import { assertTextContent, assertTextPath } from "../file/text-policy.js";
import { VaultPathSandbox, type VaultRelativePath } from "../path/vault-path.js";
import { MAX_PATCH_INPUT_BYTES, prepareVaultPatch } from "../patch/prepare-vault-patch.js";
import { assertVersionMatch, computeContentVersion, parseContentVersion, type ContentVersion } from "../version/content-version.js";
import { nativeMutationIO, type MutationIO } from "./mutation-io.js";
import { withPathLock } from "./path-lock.js";
import { checkDirectories, ensureParentDirectories, hasCode, sameIdentity, sameSnapshot } from "./filesystem-checks.js";
import { changed, VaultMutationError } from "./mutation-errors.js";
import { deleteVaultFile, moveVaultFile, type VaultDeleteOptions, type VaultDeleteResult, type VaultMoveOptions, type VaultMoveResult } from "./file-operations.js";
export { VaultMutationError, type VaultMutationErrorCode } from "./mutation-errors.js";

export interface VaultMutationOptions {
  /** Default 4 MiB; inclusive hard maximum 64 MiB for old AND new bytes. */
  readonly maxBytes?: number;
  /** Trusted test adapter, never a tool input or a permissions policy. */
  readonly io?: MutationIO;
}
export interface VaultMutationResult {
  readonly message: "OK";
  readonly path: VaultRelativePath;
  readonly version: ContentVersion;
  readonly sizeBytes: number;
  readonly created: boolean;
  readonly warnings?: readonly (Warning | { readonly code: "temporary_cleanup_failed"; readonly message: string })[];
}
interface Snapshot { readonly document: VaultDocumentReadResult; readonly stats: BigIntStats }

/** Lightweight file operations. Deployment filesystem permissions decide access.
 * Parent identities are revalidated; directories must still be a trusted
 * namespace. Node path-based calls are not a cross-process directory lock/CAS.
 */
export class VaultMutationStore {
  readonly #sandbox: VaultPathSandbox;
  readonly #io: MutationIO;
  readonly #maxBytes: number;
  private constructor(sandbox: VaultPathSandbox, options: VaultMutationOptions) {
    this.#sandbox = sandbox;
    this.#io = options.io ?? nativeMutationIO;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_VAULT_DOCUMENT_BYTES;
  }
  static async create(sandbox: VaultPathSandbox, options: VaultMutationOptions = {}): Promise<VaultMutationStore> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_VAULT_DOCUMENT_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_VAULT_DOCUMENT_BYTES) {
      throw new VaultMutationError("invalid_configuration", "Invalid mutation byte limit");
    }
    await sandbox.resolve("", { allowRoot: true });
    return new VaultMutationStore(sandbox, options);
  }

  async write(inputPath: string, content: string, options: { readonly ifMatch?: string } = {}): Promise<VaultMutationResult> {
    this.#validateText(inputPath, content);
    return this.#mutate(inputPath, options.ifMatch, false, () => ({ content, warnings: [] }));
  }
  async move(inputPath: string, destination: string, options: VaultMoveOptions = {}): Promise<VaultMoveResult> {
    return moveVaultFile(this.#sandbox, inputPath, destination, options, this.#io);
  }
  async delete(inputPath: string, options: VaultDeleteOptions = {}): Promise<VaultDeleteResult> {
    return deleteVaultFile(this.#sandbox, inputPath, options, this.#io);
  }
  async append(inputPath: string, content: string, options: { readonly ifMatch?: string } = {}): Promise<VaultMutationResult> {
    this.#validateText(inputPath, content);
    return this.#mutate(inputPath, options.ifMatch, false, previous => ({
      // Local REST 5.3.1 adds LF even when an existing file is empty.
      content: previous ? previous.content + (previous.content.endsWith("\n") ? "" : "\n") + content : content,
      warnings: [],
    }));
  }
  async patch(inputPath: string, instruction: unknown): Promise<VaultMutationResult> {
    requireJson(instruction);
    // Capture caller-owned JSON before waiting on the path lock.
    const serialized = JSON.stringify(instruction);
    if (Buffer.byteLength(serialized, "utf8") > MAX_PATCH_INPUT_BYTES) {
      throw new VaultMutationError("too_large", "Patch input exceeds 4 MiB", { path: inputPath });
    }
    const captured: unknown = JSON.parse(serialized);
    if (!captured || typeof captured !== "object" || !("ifMatch" in captured) || typeof captured.ifMatch !== "string") {
      throw new VaultMutationError("if_match_required", "vault_patch requires ifMatch", { path: inputPath });
    }
    return this.#mutate(inputPath, captured.ifMatch, true, previous => {
      const prepared = prepareVaultPatch(previous!, captured);
      return { content: prepared.document, warnings: prepared.warnings };
    });
  }
  #validateText(inputPath: string, content: string): void {
    this.#sandbox.parse(inputPath);
    assertTextPath(inputPath);
    assertTextContent(inputPath, content);
    if (Buffer.byteLength(content, "utf8") > this.#maxBytes) {
      throw new VaultMutationError("too_large", "Mutation exceeds the configured exact-byte limit", { path: inputPath });
    }
  }
  async #snapshot(inputPath: string): Promise<Snapshot | undefined> {
    const resolved = await this.#sandbox.resolve(inputPath, { rejectNameAliases: true });
    let stats: BigIntStats;
    try { stats = await lstat(resolved.absolutePath, { bigint: true }); }
    catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
    if (!stats.isFile() || stats.nlink !== 1n) {
      throw new VaultMutationError("unsafe_target", "Mutation target must be a regular file with one hard link; multiple hard links may indicate stale temporary cleanup residue", { path: inputPath });
    }
    const document = await readVaultDocument(this.#sandbox, inputPath, { maxBytes: this.#maxBytes });
    const after = await lstat(resolved.absolutePath, { bigint: true });
    if (!sameSnapshot(stats, after)) throw changed(inputPath);
    return { document, stats: after };
  }

  async #mutate(inputPath: string, ifMatch: string | undefined, mustExist: boolean,
    prepare: (previous: VaultDocumentReadResult | undefined) => { content: string; warnings: readonly Warning[] }): Promise<VaultMutationResult> {
    const relative = this.#sandbox.parse(inputPath);
    assertTextPath(inputPath);
    if (ifMatch !== undefined) parseContentVersion(ifMatch);
    return withPathLock(this.#sandbox.root, relative, async () => {
      const previous = await this.#snapshot(relative);
      if (previous) {
        if (ifMatch === undefined) throw new VaultMutationError("if_match_required", "Existing-file mutations require ifMatch", { path: relative });
        assertVersionMatch(previous.document.version, ifMatch);
      } else {
        if (mustExist) throw new VaultDocumentNotFoundError(relative);
        if (ifMatch !== undefined) throw new VaultMutationError("version_conflict", "The versioned mutation target no longer exists", { path: relative });
      }
      const prepared = prepare(previous?.document);
      this.#validateText(relative, prepared.content);
      const bytes = Buffer.from(prepared.content, "utf8");
      const version = computeContentVersion(bytes);
      const parents = await ensureParentDirectories(this.#sandbox, relative);
      const destination = (await this.#sandbox.resolve(relative, { rejectNameAliases: true })).absolutePath;
      // Same directory => same filesystem and natural owner/group/default-ACL
      // inheritance. Dot-prefix + .tmp keeps artifacts out of all MCP discovery
      // and direct access through the shared protected-internal path policy.
      const temporary = path.join(path.dirname(destination), `.obsidian-mcp-${randomUUID()}.tmp`);
      let identity: BigIntStats | undefined;
      let file: FileHandle | undefined;
      let temporaryExists = false;
      let published = false;
      let failure: unknown;
      let cleanupFailure: unknown;
      try {
        await this.#sandbox.resolve(relative, { rejectNameAliases: true });
        await checkDirectories(parents, relative);
        // Default creation mode: OS umask/default ACLs decide access. No chmod,
        // chown, ACL editor or post-creation permissions hook exists here.
        file = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL |
          (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
        temporaryExists = true;
        identity = await file.stat({ bigint: true });
        await this.#io.writeFile(file, bytes);
        // One pre-publication file fsync; no directory fsync or durability state.
        await this.#io.syncFile(file);
        const ready = await file.stat({ bigint: true });
        if (!ready.isFile() || ready.nlink !== 1n || ready.size !== BigInt(bytes.length) || !sameIdentity(identity, ready)) {
          throw new VaultMutationError("temporary_changed", "Temporary file changed before publication");
        }
        await this.#io.closeFile(file); file = undefined;
        const finalPath = await this.#sandbox.resolve(relative, { rejectNameAliases: true });
        await checkDirectories(parents, relative);
        if (!sameSnapshot(ready, await lstat(temporary, { bigint: true }))) {
          throw new VaultMutationError("temporary_changed", "Temporary file changed before publication");
        }
        // Exact bytes and metadata are checked after staging, with no rebase or
        // transparent retry. This checkpoint is not a CAS with external Sync.
        const current = await this.#snapshot(relative);
        if (previous) {
          if (!current) throw changed(relative);
          assertVersionMatch(current.document.version, ifMatch!);
          if (!sameSnapshot(previous.stats, current.stats)) throw changed(relative);
          await this.#io.rename(temporary, finalPath.absolutePath);
          temporaryExists = false; // Rename consumed the temporary name.
        } else {
          if (current) throw changed(relative);
          try { await this.#io.link(temporary, finalPath.absolutePath); }
          catch (error) { if (hasCode(error, "EEXIST")) throw changed(relative); throw error; }
        }
        published = true;
      } catch (error) { failure = error; }
      try {
        if (file) await file.close();
        if (temporaryExists) {
          const parentRelative = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
          await this.#sandbox.resolve(parentRelative, { allowRoot: true, rejectNameAliases: true });
          await checkDirectories(parents, relative);
          const remaining = await lstat(temporary, { bigint: true });
          if (!identity || !sameIdentity(identity, remaining)) throw new Error("Temporary file identity changed");
          await this.#io.unlink(temporary);
        }
      } catch (error) { if (!hasCode(error, "ENOENT")) cleanupFailure = error; }
      if (!published) {
        if (cleanupFailure) throw new VaultMutationError("cleanup_failed", "Mutation was not published; a protected temporary file may remain", { path: relative }, { cause: new AggregateError([failure, cleanupFailure]) });
        if (hasCode(failure, "EXDEV")) throw new VaultMutationError("cross_device", "Atomic publication requires the same filesystem", { path: relative }, { cause: failure });
        throw failure;
      }
      // A successful create is still successful if its extra hidden hard-link
      // name cannot be cleaned. Warn instead of inviting a repeated append.
      const warnings = [...prepared.warnings, ...(cleanupFailure ? [{ code: "temporary_cleanup_failed" as const,
        message: "The note was saved, but a protected temporary file remains; filesystem cleanup is needed." }] : [])];
      return { message: "OK", path: relative, version, sizeBytes: bytes.length, created: previous === undefined,
        ...(warnings.length ? { warnings } : {}) };
    });
  }

}
