import type { VaultPathErrorCode, VaultPathSandbox } from "../path/vault-path.js";
import {
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_ENTRIES,
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILES,
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILE_BYTES,
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_TOTAL_BYTES,
  MAX_VAULT_MARKDOWN_SCAN_ENTRIES,
  MAX_VAULT_MARKDOWN_SCAN_FILES,
  MAX_VAULT_MARKDOWN_SCAN_FILE_BYTES,
  MAX_VAULT_MARKDOWN_SCAN_TOTAL_BYTES,
  scanVaultMarkdownDocuments,
  type VaultMarkdownDocumentReader,
  type VaultMarkdownScanBudgetName,
} from "../traversal/scan-vault-markdown.js";
import { toNoteJson } from "../document/note-json.js";

export const DEFAULT_TAG_LIST_MAX_ENTRIES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_ENTRIES;
export const DEFAULT_TAG_LIST_MAX_FILES = DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILES;
export const DEFAULT_TAG_LIST_MAX_FILE_BYTES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILE_BYTES;
export const DEFAULT_TAG_LIST_MAX_TAGS = 5_000;
export const DEFAULT_TAG_LIST_MAX_TOTAL_BYTES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_TOTAL_BYTES;
export const MAX_TAG_LIST_ENTRIES = MAX_VAULT_MARKDOWN_SCAN_ENTRIES;
export const MAX_TAG_LIST_FILES = MAX_VAULT_MARKDOWN_SCAN_FILES;
export const MAX_TAG_LIST_FILE_BYTES = MAX_VAULT_MARKDOWN_SCAN_FILE_BYTES;
export const MAX_TAG_LIST_TAGS = 50_000;
export const MAX_TAG_LIST_TOTAL_BYTES = MAX_VAULT_MARKDOWN_SCAN_TOTAL_BYTES;

export interface ListVaultTagsOptions {
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxTags?: number;
  readonly maxTotalBytes?: number;
}

export interface VaultTagCount {
  /** First deterministic source casing; no leading `#`. */
  readonly name: string;
  /** Number of Markdown files containing this tag or one of its descendants. */
  readonly count: number;
}

export interface ListVaultTagsResult {
  readonly tags: readonly VaultTagCount[];
}

export type TagListBudgetName = VaultMarkdownScanBudgetName | "maxTags";

export type VaultTagListErrorCode =
  | "budget_exceeded"
  | "invalid_option"
  | "source_unavailable"
  | "traversal_changed"
  | "traversal_unavailable"
  | "unsafe_entry_name";

export abstract class VaultTagListError extends Error {
  abstract readonly code: VaultTagListErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = "VaultTagListError";
  }
}

export type TagListOptionName =
  | "maxEntries"
  | "maxFileBytes"
  | "maxFiles"
  | "maxTags"
  | "maxTotalBytes";

export class InvalidVaultTagListOptionError extends VaultTagListError {
  override readonly code = "invalid_option";
  readonly maximum: number;
  readonly minimum: number;
  readonly option: TagListOptionName;
  readonly value: number;

  constructor(
    option: TagListOptionName,
    value: number,
    minimum: number,
    maximum: number,
  ) {
    super(`${option} must be an integer from ${minimum} through ${maximum}`);
    this.name = "InvalidVaultTagListOptionError";
    this.maximum = maximum;
    this.minimum = minimum;
    this.option = option;
    this.value = value;
  }
}

export class VaultTagListBudgetExceededError extends VaultTagListError {
  override readonly code = "budget_exceeded";
  readonly budget: TagListBudgetName;
  readonly limit: number;
  readonly observedAtLeast: bigint;

  constructor(
    budget: TagListBudgetName,
    limit: number,
    observedAtLeast: bigint,
  ) {
    super(`tag_list exceeded its ${budget} budget of ${limit}`);
    this.name = "VaultTagListBudgetExceededError";
    this.budget = budget;
    this.limit = limit;
    this.observedAtLeast = observedAtLeast;
  }
}

export class VaultTagListUnsafeEntryNameError extends VaultTagListError {
  override readonly code = "unsafe_entry_name";
  readonly directory: string;
  readonly entryName: string;
  readonly reason: VaultPathErrorCode;

  constructor(
    directory: string,
    entryName: string,
    reason: VaultPathErrorCode,
  ) {
    super("Vault entry cannot be represented as a canonical tag-list path");
    this.name = "VaultTagListUnsafeEntryNameError";
    this.directory = directory;
    this.entryName = entryName;
    this.reason = reason;
  }
}

export class VaultTagListTraversalChangedError extends VaultTagListError {
  override readonly code = "traversal_changed";
  readonly path: string;

  constructor(pathValue: string) {
    super(`Vault directory changed during tag traversal: ${displayPath(pathValue)}`);
    this.name = "VaultTagListTraversalChangedError";
    this.path = pathValue;
  }
}

export class VaultTagListTraversalUnavailableError extends VaultTagListError {
  override readonly code = "traversal_unavailable";
  readonly osCode?: string;
  readonly path: string;

  constructor(pathValue: string, osCode?: string) {
    super(`Vault directory could not be traversed for tags: ${displayPath(pathValue)}`);
    this.name = "VaultTagListTraversalUnavailableError";
    this.path = pathValue;
    if (osCode !== undefined) this.osCode = osCode;
  }
}

export class VaultTagListSourceUnavailableError extends VaultTagListError {
  override readonly code = "source_unavailable";
  readonly osCode?: string;
  readonly path: string;

  constructor(pathValue: string, osCode?: string) {
    super(`Vault Markdown source could not be read for tags: ${pathValue}`);
    this.name = "VaultTagListSourceUnavailableError";
    this.path = pathValue;
    if (osCode !== undefined) this.osCode = osCode;
  }
}

interface ResolvedTagListOptions {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTags: number;
  readonly maxTotalBytes: number;
}

interface MutableTagCount {
  count: number;
  readonly name: string;
}

/** Lists all conservatively recognized tags using one safe, bounded Vault scan. */
export async function listVaultTags(
  sandbox: VaultPathSandbox,
  readDocument: VaultMarkdownDocumentReader,
  options: ListVaultTagsOptions = {},
): Promise<ListVaultTagsResult> {
  const resolved = resolveOptions(options);
  const counts = new Map<string, MutableTagCount>();

  await scanVaultMarkdownDocuments(
    sandbox,
    readDocument,
    resolved,
    {
      budgetExceeded: (budget, limit, observedAtLeast) =>
        new VaultTagListBudgetExceededError(budget, limit, observedAtLeast),
      sourceUnavailable: (pathValue, osCode) =>
        new VaultTagListSourceUnavailableError(pathValue, osCode),
      traversalChanged: (pathValue) =>
        new VaultTagListTraversalChangedError(pathValue),
      traversalUnavailable: (pathValue, osCode) =>
        new VaultTagListTraversalUnavailableError(pathValue, osCode),
      unsafeEntryName: (directory, entryName, reason) =>
        new VaultTagListUnsafeEntryNameError(directory, entryName, reason),
    },
    (document) => {
      const tagsInFile = new Map<string, string>();
      for (const explicitTag of toNoteJson(document).tags) {
        for (const effectiveTag of expandTagAndParents(explicitTag)) {
          const key = canonicalTagKey(effectiveTag);
          if (!tagsInFile.has(key)) tagsInFile.set(key, effectiveTag);
        }
      }

      for (const [key, name] of tagsInFile) {
        const existing = counts.get(key);
        if (existing !== undefined) {
          existing.count += 1;
          continue;
        }
        if (counts.size >= resolved.maxTags) {
          throw new VaultTagListBudgetExceededError(
            "maxTags",
            resolved.maxTags,
            BigInt(counts.size + 1),
          );
        }
        counts.set(key, { count: 1, name });
      }
    },
  );

  const tags = [...counts.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([, tag]) => Object.freeze({ count: tag.count, name: tag.name }));
  return Object.freeze({ tags: Object.freeze(tags) });
}

function resolveOptions(options: ListVaultTagsOptions): ResolvedTagListOptions {
  return Object.freeze({
    maxEntries: resolveIntegerOption(
      "maxEntries",
      options.maxEntries,
      DEFAULT_TAG_LIST_MAX_ENTRIES,
      1,
      MAX_TAG_LIST_ENTRIES,
    ),
    maxFileBytes: resolveIntegerOption(
      "maxFileBytes",
      options.maxFileBytes,
      DEFAULT_TAG_LIST_MAX_FILE_BYTES,
      0,
      MAX_TAG_LIST_FILE_BYTES,
    ),
    maxFiles: resolveIntegerOption(
      "maxFiles",
      options.maxFiles,
      DEFAULT_TAG_LIST_MAX_FILES,
      1,
      MAX_TAG_LIST_FILES,
    ),
    maxTags: resolveIntegerOption(
      "maxTags",
      options.maxTags,
      DEFAULT_TAG_LIST_MAX_TAGS,
      1,
      MAX_TAG_LIST_TAGS,
    ),
    maxTotalBytes: resolveIntegerOption(
      "maxTotalBytes",
      options.maxTotalBytes,
      DEFAULT_TAG_LIST_MAX_TOTAL_BYTES,
      0,
      MAX_TAG_LIST_TOTAL_BYTES,
    ),
  });
}

function resolveIntegerOption(
  option: TagListOptionName,
  configured: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = configured ?? defaultValue;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidVaultTagListOptionError(
      option,
      value,
      minimum,
      maximum,
    );
  }
  return value;
}

function expandTagAndParents(tag: string): readonly string[] {
  const parts = tag.split("/");
  const expanded: string[] = [];
  for (let length = 1; length <= parts.length; length += 1) {
    expanded.push(parts.slice(0, length).join("/"));
  }
  return expanded;
}

function canonicalTagKey(tag: string): string {
  return tag.toLowerCase();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function displayPath(pathValue: string): string {
  return pathValue.length === 0 ? "<vault-root>" : pathValue;
}
