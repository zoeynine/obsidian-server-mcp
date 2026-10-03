import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  InvalidVaultSearchQueryError,
  InvalidVaultSearchQueryOptionError,
  VaultSearchQueryBudgetExceededError,
  VaultSearchQueryError,
  VaultSearchQuerySourceUnavailableError,
  VaultSearchQueryTraversalChangedError,
  VaultSearchQueryTraversalUnavailableError,
  VaultSearchQueryUnsafeEntryNameError,
} from "../../core/search/search-vault-query.js";
import {
  toKnownVaultReadToolErrorPayload,
  type KnownVaultReadToolErrorCode,
} from "./vault-read-errors.js";

export type SearchQueryToolErrorCode =
  | KnownVaultReadToolErrorCode
  | `search_query.${VaultSearchQueryError["code"]}`
  | "search_query.internal_error";

export interface SearchQueryToolErrorPayload {
  readonly error: {
    readonly code: SearchQueryToolErrorCode;
    readonly details?: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
}

/** Maps query compilation/scan failures without exposing stacks or roots. */
export function mapSearchQueryToolError(error: unknown): CallToolResult {
  const payload = toSearchQueryToolErrorPayload(error);

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function toSearchQueryToolErrorPayload(
  error: unknown,
): SearchQueryToolErrorPayload {
  const readPayload = toKnownVaultReadToolErrorPayload(error);
  if (readPayload !== undefined) return readPayload;

  if (error instanceof VaultSearchQueryError) {
    return {
      error: {
        code: `search_query.${error.code}`,
        details: searchQueryErrorDetails(error),
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "search_query.internal_error",
      message: "search_query failed unexpectedly",
    },
  };
}

function searchQueryErrorDetails(
  error: VaultSearchQueryError,
): Readonly<Record<string, number | string>> {
  const details: Record<string, number | string> = {};

  if (error instanceof InvalidVaultSearchQueryError) {
    details["reason"] = error.reason;
    Object.assign(details, error.details);
  } else if (error instanceof InvalidVaultSearchQueryOptionError) {
    details["maximum"] = error.maximum;
    details["minimum"] = error.minimum;
    details["option"] = error.option;
    details["value"] = Number.isFinite(error.value)
      ? error.value
      : String(error.value);
  } else if (error instanceof VaultSearchQueryBudgetExceededError) {
    details["budget"] = error.budget;
    details["limit"] = error.limit;
    details["observedAtLeast"] = error.observedAtLeast.toString();
  } else if (error instanceof VaultSearchQueryUnsafeEntryNameError) {
    details["directory"] = error.directory;
    details["entryName"] = error.entryName;
    details["reason"] = error.reason;
  } else if (
    error instanceof VaultSearchQueryTraversalChangedError ||
    error instanceof VaultSearchQueryTraversalUnavailableError ||
    error instanceof VaultSearchQuerySourceUnavailableError
  ) {
    details["path"] = error.path;
    if ("osCode" in error && error.osCode !== undefined) {
      details["osCode"] = error.osCode;
    }
  }

  return details;
}
