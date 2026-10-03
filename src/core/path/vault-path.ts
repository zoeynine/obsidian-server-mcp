import { lstat, readdir, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import * as path from "node:path";

const vaultRelativePathBrand: unique symbol = Symbol("VaultRelativePath");

export type VaultRelativePath = string & {
  readonly [vaultRelativePathBrand]: true;
};

export type VaultPathErrorCode =
  | "absolute_path"
  | "empty_path"
  | "filename_conflict"
  | "invalid_root"
  | "non_canonical_path"
  | "outside_vault"
  | "parent_traversal"
  | "protected_path"
  | "symlink_traversal"
  | "unsafe_portable_name";

export class VaultPathError extends Error {
  readonly code: VaultPathErrorCode;
  readonly input: string;

  constructor(code: VaultPathErrorCode, input: string, message: string) {
    super(message);
    this.name = "VaultPathError";
    this.code = code;
    this.input = input;
  }
}

export interface ParseVaultPathOptions {
  readonly allowRoot?: boolean;
}

const windowsDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const windowsUnsafeCharacter = /[<>:"|?*]/u;
const controlCharacter = /[\u0000-\u001f\u007f]/u;

/**
 * Parses the API's canonical, portable Vault path format.
 *
 * The format always uses `/` separators. An empty string can represent the
 * Vault root only when explicitly allowed. No filesystem access occurs here.
 */
export function parseVaultRelativePath(
  input: string,
  options: ParseVaultPathOptions = {},
): VaultRelativePath {
  if (input.length === 0) {
    if (options.allowRoot === true) {
      return input as VaultRelativePath;
    }

    throw new VaultPathError("empty_path", input, "Vault path must not be empty");
  }

  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[a-z]:/iu.test(input)
  ) {
    throw new VaultPathError(
      "absolute_path",
      input,
      "Vault path must be relative and must not include a drive prefix",
    );
  }

  if (input.includes("\\")) {
    throw new VaultPathError(
      "non_canonical_path",
      input,
      "Vault path must use forward-slash separators",
    );
  }

  if (controlCharacter.test(input)) {
    throw new VaultPathError(
      "non_canonical_path",
      input,
      "Vault path must not contain control characters",
    );
  }

  if (!input.isWellFormed()) {
    throw new VaultPathError("non_canonical_path", input, "Vault path must be well-formed Unicode");
  }

  const segments = input.split("/");

  for (const segment of segments) {
    if (segment === "..") {
      throw new VaultPathError(
        "parent_traversal",
        input,
        "Vault path must not contain parent traversal segments",
      );
    }

    if (segment.length === 0 || segment === ".") {
      throw new VaultPathError(
        "non_canonical_path",
        input,
        "Vault path must not contain empty or current-directory segments",
      );
    }

    if (
      windowsUnsafeCharacter.test(segment) ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      windowsDeviceName.test(segment)
    ) {
      throw new VaultPathError(
        "unsafe_portable_name",
        input,
        `Vault path segment is unsafe across supported filesystems: ${segment}`,
      );
    }
  }

  return input as VaultRelativePath;
}

export interface ResolveVaultPathOptions extends ParseVaultPathOptions {
  readonly mustExist?: boolean;
  /** Refuse case/Unicode aliases when a mutation could create a Sync conflict. */
  readonly rejectNameAliases?: boolean;
}

export interface ResolvedVaultPath {
  readonly absolutePath: string;
  readonly relativePath: VaultRelativePath;
}

/**
 * Filesystem-aware boundary for resolving untrusted Vault-relative paths.
 *
 * Existing path components are checked for symbolic links and physical Vault
 * containment. This is a preflight primitive; mutation code must call it as
 * part of the mutation operation and must still provide atomic write semantics.
 */
export class VaultPathSandbox {
  readonly #root: string;
  readonly #protectedPaths: readonly string[];
  readonly #rootIdentity: BigIntStats;

  private constructor(root: string, protectedPaths: readonly string[], identity: BigIntStats) {
    this.#root = root;
    this.#protectedPaths = protectedPaths;
    this.#rootIdentity = identity;
  }

  static async create(vaultRoot: string, options: { readonly protectedPaths?: readonly string[] } = {}): Promise<VaultPathSandbox> {
    if (!path.isAbsolute(vaultRoot)) {
      throw new VaultPathError(
        "invalid_root",
        vaultRoot,
        "Vault root must be an absolute path",
      );
    }

    const rootStats = await lstat(vaultRoot, { bigint: true });

    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new VaultPathError(
        "invalid_root",
        vaultRoot,
        "Vault root must be a real directory, not a symbolic link",
      );
    }

    return new VaultPathSandbox(await realpath(vaultRoot), (options.protectedPaths ?? []).map(
      (entry) => parseVaultRelativePath(entry).normalize("NFC").toLowerCase(),
    ), rootStats);
  }

  get root(): string {
    return this.#root;
  }

  /** The one lexical policy used by direct access, discovery and mutations. */
  parse(input: string, options: ParseVaultPathOptions = {}): VaultRelativePath {
    const parsed = parseVaultRelativePath(input, options);
    const key = parsed.normalize("NFC").toLowerCase();
    if (parsed.split("/").some((part) => part.startsWith(".")) ||
        this.#protectedPaths.some((prefix) => key === prefix || key.startsWith(`${prefix}/`))) {
      throw new VaultPathError("protected_path", input, "Vault path is protected");
    }
    return parsed;
  }

  /** Discovery hides protected entries but still rejects malformed names. */
  discover(input: string): VaultRelativePath | undefined {
    try { return this.parse(input); }
    catch (error) {
      if (error instanceof VaultPathError && error.code === "protected_path") return undefined;
      throw error;
    }
  }

  async resolve(
    input: string,
    options: ResolveVaultPathOptions = {},
  ): Promise<ResolvedVaultPath> {
    const relativePath = this.parse(input, options);
    return this.#resolveChecked(relativePath, options);
  }

  /** Local REST destination normalization, without ever normalizing away an
   * absolute path or a parent traversal. Source paths remain strict. */
  parseMoveDestination(source: VaultRelativePath, destination: string): VaultRelativePath {
    const trimmed = destination.trim();
    if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[a-z]:/iu.test(trimmed)) {
      this.parse(trimmed); // The same lexical chokepoint produces the rejection.
    }
    const normalized = trimmed.replace(/\\/gu, "/").replace(/\/+/gu, "/");
    return this.parse(!normalized || normalized.endsWith("/") ? normalized + source.split("/").at(-1)! : normalized);
  }

  /** Internal trash is the only privileged namespace, never a tool-supplied
   * destination. Reuses all physical containment/symlink/root checks below;
   * ordinary resolve/parse still hard-reject direct access to .trash.
   */
  async resolveInternalTrash(child = "", options: { readonly mustExist?: boolean } = {}): Promise<ResolvedVaultPath> {
    const relative = this.parse(child, { allowRoot: true });
    return this.#resolveChecked(parseVaultRelativePath(relative ? `.trash/${relative}` : ".trash"), options);
  }

  async #resolveChecked(relativePath: VaultRelativePath, options: ResolveVaultPathOptions): Promise<ResolvedVaultPath> {
    const input = relativePath;
    const segments = relativePath.length === 0 ? [] : relativePath.split("/");
    const absolutePath = path.join(this.#root, ...segments);

    if (!isWithin(this.#root, absolutePath)) {
      throw new VaultPathError(
        "outside_vault",
        input,
        "Resolved path is outside the Vault root",
      );
    }

    let currentPath = this.#root;
    let foundMissingComponent = false;

    const rootStats = await lstat(this.#root, { bigint: true });
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || rootStats.dev !== this.#rootIdentity.dev ||
        rootStats.ino !== this.#rootIdentity.ino || await realpath(this.#root) !== this.#root) {
      throw new VaultPathError("invalid_root", input, "Vault root is no longer a real directory");
    }

    for (const segment of segments) {
      if (options.rejectNameAliases === true) {
        const key = segment.normalize("NFC").toLowerCase();
        const entries = await readdir(currentPath);
        if (entries.some(entry => entry !== segment && entry.normalize("NFC").toLowerCase() === key)) {
          throw new VaultPathError("filename_conflict", input, "Vault path conflicts with an existing case or Unicode spelling");
        }
      }
      currentPath = path.join(currentPath, segment);

      try {
        const stats = await lstat(currentPath);

        if (stats.isSymbolicLink()) {
          throw new VaultPathError(
            "symlink_traversal",
            input,
            `Vault path traverses a symbolic link: ${segment}`,
          );
        }

        const physicalPath = await realpath(currentPath);
        if (!isWithin(this.#root, physicalPath)) {
          throw new VaultPathError(
            "outside_vault",
            input,
            "Resolved physical path is outside the Vault root",
          );
        }
      } catch (error: unknown) {
        if (isMissingPathError(error)) {
          foundMissingComponent = true;
          break;
        }

        throw error;
      }
    }

    if (options.mustExist === true && foundMissingComponent) {
      const error = new Error(`Vault path does not exist: ${relativePath}`);
      Object.assign(error, { code: "ENOENT" });
      throw error;
    }

    return Object.freeze({ absolutePath, relativePath });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
