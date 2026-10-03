import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  InvalidVaultTagListOptionError,
  VaultTagListBudgetExceededError,
  VaultTagListError,
  VaultTagListSourceUnavailableError,
  VaultTagListTraversalChangedError,
  VaultTagListTraversalUnavailableError,
  VaultTagListUnsafeEntryNameError,
} from "../../core/tag/list-vault-tags.js";
import {
  toKnownVaultReadToolErrorPayload,
  type KnownVaultReadToolErrorCode,
} from "./vault-read-errors.js";

export type TagListToolErrorCode =
  | KnownVaultReadToolErrorCode
  | `tag_list.${VaultTagListError["code"]}`
  | "tag_list.internal_error";

export interface TagListToolErrorPayload {
  readonly error: {
    readonly code: TagListToolErrorCode;
    readonly details?: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
}

/** Maps tag-scan and reused safe-read failures without exposing stacks or roots. */
export function mapTagListToolError(error: unknown): CallToolResult {
  const payload = toTagListToolErrorPayload(error);
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function toTagListToolErrorPayload(error: unknown): TagListToolErrorPayload {
  const readPayload = toKnownVaultReadToolErrorPayload(error);
  if (readPayload !== undefined) return readPayload;

  if (error instanceof VaultTagListError) {
    return {
      error: {
        code: `tag_list.${error.code}`,
        details: tagListErrorDetails(error),
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "tag_list.internal_error",
      message: "tag_list failed unexpectedly",
    },
  };
}

function tagListErrorDetails(
  error: VaultTagListError,
): Readonly<Record<string, number | string>> {
  const details: Record<string, number | string> = {};

  if (error instanceof InvalidVaultTagListOptionError) {
    details["maximum"] = error.maximum;
    details["minimum"] = error.minimum;
    details["option"] = error.option;
    details["value"] = Number.isFinite(error.value)
      ? error.value
      : String(error.value);
  } else if (error instanceof VaultTagListBudgetExceededError) {
    details["budget"] = error.budget;
    details["limit"] = error.limit;
    details["observedAtLeast"] = error.observedAtLeast.toString();
  } else if (error instanceof VaultTagListUnsafeEntryNameError) {
    details["directory"] = error.directory;
    details["entryName"] = error.entryName;
    details["reason"] = error.reason;
  } else if (
    error instanceof VaultTagListTraversalChangedError ||
    error instanceof VaultTagListTraversalUnavailableError ||
    error instanceof VaultTagListSourceUnavailableError
  ) {
    details["path"] = error.path;
    if ("osCode" in error && error.osCode !== undefined) {
      details["osCode"] = error.osCode;
    }
  }

  return details;
}
