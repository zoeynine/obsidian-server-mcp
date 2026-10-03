import {
  type VaultPathErrorCode,
  type VaultPathSandbox,
  type VaultRelativePath,
} from "../path/vault-path.js";
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
import { toNoteJson, type JsonValue } from "../document/note-json.js";
import { validateQuery, QueryEvaluator } from "./json-logic-query.js";
import { MAX_SEARCH_QUERY_OUTPUT_BYTES } from "./query-limits.js";
import type { ContentVersion } from "../version/content-version.js";

export const DEFAULT_SEARCH_QUERY_MAX_ENTRIES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_ENTRIES;
export const DEFAULT_SEARCH_QUERY_MAX_FILES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILES;
export const DEFAULT_SEARCH_QUERY_MAX_FILE_BYTES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_FILE_BYTES;
export const DEFAULT_SEARCH_QUERY_MAX_RESULTS = 500;
export const DEFAULT_SEARCH_QUERY_MAX_TOTAL_BYTES =
  DEFAULT_VAULT_MARKDOWN_SCAN_MAX_TOTAL_BYTES;
export const MAX_SEARCH_QUERY_ENTRIES = MAX_VAULT_MARKDOWN_SCAN_ENTRIES;
export const MAX_SEARCH_QUERY_FILES = MAX_VAULT_MARKDOWN_SCAN_FILES;
export const MAX_SEARCH_QUERY_FILE_BYTES = MAX_VAULT_MARKDOWN_SCAN_FILE_BYTES;
export const MAX_SEARCH_QUERY_RESULTS = 10_000;
export const MAX_SEARCH_QUERY_TOTAL_BYTES = MAX_VAULT_MARKDOWN_SCAN_TOTAL_BYTES;
export const MAX_SEARCH_QUERY_SERIALIZED_BYTES = 16 * 1024;
export const MAX_SEARCH_QUERY_AST_NODES = 64;
export const MAX_SEARCH_QUERY_DEPTH = 8;
export const MAX_SEARCH_QUERY_STRING_LENGTH = 1_024;

export interface SearchVaultQueryOptions {
  /** Global count of all child filesystem entries observed during traversal. */
  readonly maxEntries?: number;
  /** Global count of regular `.md` files accepted for searching. */
  readonly maxFiles?: number;
  /** Inclusive exact-byte limit for each Markdown file. */
  readonly maxFileBytes?: number;
  /** Global count of matching Markdown files. */
  readonly maxResults?: number;
  /** Inclusive exact-byte sum across all successfully read Markdown files. */
  readonly maxTotalBytes?: number;
}

export interface SearchVaultQueryResultEntry {
  /** Canonical Vault-relative path of the matched Markdown file. */
  readonly filename: VaultRelativePath;
  readonly result: JsonValue;
  /** Exact-byte version of the content evaluated for this result. */
  readonly version: ContentVersion;
}

export type SearchQueryBudgetName =
  | VaultMarkdownScanBudgetName
  | "maxOutputBytes"
  | "maxResults";

export type SearchQueryOptionName =
  | "maxEntries"
  | "maxFileBytes"
  | "maxFiles"
  | "maxResults"
  | "maxTotalBytes";

export type SearchQueryInvalidReason =
  | "evaluation_failed"
  | "evaluation_limit"
  | "ast_depth"
  | "ast_nodes"
  | "invalid_shape"
  | "invalid_var"
  | "not_json_serializable"
  | "string_too_long"
  | "unsupported_operator"
  | "query_too_large";

export type VaultSearchQueryErrorCode =
  | "budget_exceeded"
  | "invalid_option"
  | "invalid_query"
  | "source_unavailable"
  | "traversal_changed"
  | "traversal_unavailable"
  | "unsafe_entry_name";

export abstract class VaultSearchQueryError extends Error {
  abstract readonly code: VaultSearchQueryErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = "VaultSearchQueryError";
  }
}

export class InvalidVaultSearchQueryError extends VaultSearchQueryError {
  override readonly code = "invalid_query";
  readonly details: Readonly<Record<string, number | string>>;
  readonly reason: SearchQueryInvalidReason;

  constructor(
    reason: SearchQueryInvalidReason,
    details: Readonly<Record<string, number | string>> = {},
  ) {
    super(`search_query query is invalid: ${reason}`);
    this.name = "InvalidVaultSearchQueryError";
    this.details = Object.freeze({ ...details });
    this.reason = reason;
  }
}

export class InvalidVaultSearchQueryOptionError extends VaultSearchQueryError {
  override readonly code = "invalid_option";
  readonly maximum: number;
  readonly minimum: number;
  readonly option: SearchQueryOptionName;
  readonly value: number;

  constructor(
    option: SearchQueryOptionName,
    value: number,
    minimum: number,
    maximum: number,
  ) {
    super(`${option} must be an integer from ${minimum} through ${maximum}`);
    this.name = "InvalidVaultSearchQueryOptionError";
    this.maximum = maximum;
    this.minimum = minimum;
    this.option = option;
    this.value = value;
  }
}

export class VaultSearchQueryBudgetExceededError extends VaultSearchQueryError {
  override readonly code = "budget_exceeded";
  readonly budget: SearchQueryBudgetName;
  readonly limit: number;
  readonly observedAtLeast: bigint;

  constructor(
    budget: SearchQueryBudgetName,
    limit: number,
    observedAtLeast: bigint,
  ) {
    super(`search_query exceeded its ${budget} budget of ${limit}`);
    this.name = "VaultSearchQueryBudgetExceededError";
    this.budget = budget;
    this.limit = limit;
    this.observedAtLeast = observedAtLeast;
  }
}

export class VaultSearchQueryUnsafeEntryNameError extends VaultSearchQueryError {
  override readonly code = "unsafe_entry_name";
  readonly directory: string;
  readonly entryName: string;
  readonly reason: VaultPathErrorCode;

  constructor(
    directory: string,
    entryName: string,
    reason: VaultPathErrorCode,
  ) {
    super("Vault entry cannot be represented as a canonical search-query path");
    this.name = "VaultSearchQueryUnsafeEntryNameError";
    this.directory = directory;
    this.entryName = entryName;
    this.reason = reason;
  }
}

export class VaultSearchQueryTraversalChangedError extends VaultSearchQueryError {
  override readonly code = "traversal_changed";
  readonly path: string;

  constructor(pathValue: string) {
    super(`Vault directory changed during search-query traversal: ${displayPath(pathValue)}`);
    this.name = "VaultSearchQueryTraversalChangedError";
    this.path = pathValue;
  }
}

export class VaultSearchQueryTraversalUnavailableError extends VaultSearchQueryError {
  override readonly code = "traversal_unavailable";
  readonly osCode?: string;
  readonly path: string;

  constructor(pathValue: string, osCode?: string) {
    super(`Vault directory could not be traversed for search_query: ${displayPath(pathValue)}`);
    this.name = "VaultSearchQueryTraversalUnavailableError";
    this.path = pathValue;
    if (osCode !== undefined) this.osCode = osCode;
  }
}

export class VaultSearchQuerySourceUnavailableError extends VaultSearchQueryError {
  override readonly code = "source_unavailable";
  readonly osCode?: string;
  readonly path: string;

  constructor(pathValue: string, osCode?: string) {
    super(`Vault Markdown source could not be read for search_query: ${pathValue}`);
    this.name = "VaultSearchQuerySourceUnavailableError";
    this.path = pathValue;
    if (osCode !== undefined) this.osCode = osCode;
  }
}

interface ResolvedSearchQueryOptions {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxResults: number;
  readonly maxTotalBytes: number;
}

export async function searchVaultQuery(
  sandbox: VaultPathSandbox,
  readDocument: VaultMarkdownDocumentReader,
  query: unknown,
  options: SearchVaultQueryOptions = {},
): Promise<readonly SearchVaultQueryResultEntry[]> {
  validateQuery(query);
  const resolvedOptions = resolveOptions(options);
  const results: SearchVaultQueryResultEntry[] = [];
  let resultCount = 0;
  let resultBytes = 0;
  const evaluator = new QueryEvaluator(query);
  try {

    await scanVaultMarkdownDocuments(
      sandbox,
      readDocument,
      resolvedOptions,
      {
        budgetExceeded: (budget, limit, observedAtLeast) =>
          new VaultSearchQueryBudgetExceededError(
            budget,
            limit,
            observedAtLeast,
          ),
        sourceUnavailable: (pathValue, osCode) =>
          new VaultSearchQuerySourceUnavailableError(pathValue, osCode),
        traversalChanged: (pathValue) =>
          new VaultSearchQueryTraversalChangedError(pathValue),
        traversalUnavailable: (pathValue, osCode) =>
          new VaultSearchQueryTraversalUnavailableError(pathValue, osCode),
        unsafeEntryName: (directory, entryName, reason) =>
          new VaultSearchQueryUnsafeEntryNameError(directory, entryName, reason),
      },
      async (document) => {
        const { result, bytes } = await evaluator.evaluate(toNoteJson(document));
        if (result === null) return;
        resultBytes += bytes + Buffer.byteLength(document.path, "utf8") + 128;
        if (resultBytes > MAX_SEARCH_QUERY_OUTPUT_BYTES) {
          throw new VaultSearchQueryBudgetExceededError(
            "maxOutputBytes", MAX_SEARCH_QUERY_OUTPUT_BYTES, BigInt(resultBytes),
          );
        }

        resultCount += 1;
        if (resultCount > resolvedOptions.maxResults) {
          throw new VaultSearchQueryBudgetExceededError(
            "maxResults",
            resolvedOptions.maxResults,
            BigInt(resultCount),
          );
        }

        results.push(
          Object.freeze({
            filename: document.path,
            result,
            version: document.version,
          }),
        );
      },
    );

    return Object.freeze(results);
  } finally { await evaluator.close(); }
}

function resolveOptions(
  options: SearchVaultQueryOptions,
): ResolvedSearchQueryOptions {
  return Object.freeze({
    maxEntries: resolveIntegerOption(
      "maxEntries",
      options.maxEntries,
      DEFAULT_SEARCH_QUERY_MAX_ENTRIES,
      1,
      MAX_SEARCH_QUERY_ENTRIES,
    ),
    maxFileBytes: resolveIntegerOption(
      "maxFileBytes",
      options.maxFileBytes,
      DEFAULT_SEARCH_QUERY_MAX_FILE_BYTES,
      0,
      MAX_SEARCH_QUERY_FILE_BYTES,
    ),
    maxFiles: resolveIntegerOption(
      "maxFiles",
      options.maxFiles,
      DEFAULT_SEARCH_QUERY_MAX_FILES,
      1,
      MAX_SEARCH_QUERY_FILES,
    ),
    maxResults: resolveIntegerOption(
      "maxResults",
      options.maxResults,
      DEFAULT_SEARCH_QUERY_MAX_RESULTS,
      1,
      MAX_SEARCH_QUERY_RESULTS,
    ),
    maxTotalBytes: resolveIntegerOption(
      "maxTotalBytes",
      options.maxTotalBytes,
      DEFAULT_SEARCH_QUERY_MAX_TOTAL_BYTES,
      0,
      MAX_SEARCH_QUERY_TOTAL_BYTES,
    ),
  });
}

function resolveIntegerOption(
  option: SearchQueryOptionName,
  configured: number | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = configured ?? defaultValue;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new InvalidVaultSearchQueryOptionError(
      option,
      value,
      minimum,
      maximum,
    );
  }
  return value;
}

function displayPath(pathValue: string): string {
  return pathValue.length === 0 ? "<vault-root>" : pathValue;
}
