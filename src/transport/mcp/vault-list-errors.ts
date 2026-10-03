import type { CallToolResult } from "@modelcontextprotocol/server";
import { isFilesystemPermissionError } from "./vault-read-errors.js";

import {
  InvalidVaultListLimitError,
  VaultDirectoryTooLargeError,
  VaultEntryNameNotRepresentableError,
  VaultListError,
} from "../../core/list/list-vault-entries.js";
import {
  VaultPathError,
  type VaultPathErrorCode,
} from "../../core/path/vault-path.js";

export type VaultListToolErrorCode =
  | `vault_list.${VaultListError["code"]}`
  | `vault_path.${VaultPathErrorCode}`
  | "vault_list.permission_denied"
  | "vault_list.internal_error";

export interface VaultListToolErrorPayload {
  readonly error: {
    readonly code: VaultListToolErrorCode;
    readonly details?: Readonly<Record<string, number | string>>;
    readonly message: string;
  };
}

/** Maps list/path failures to stable MCP tool errors without exposing roots. */
export function mapVaultListToolError(error: unknown): CallToolResult {
  const payload = toPayload(error);

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function toPayload(error: unknown): VaultListToolErrorPayload {
  if (error instanceof VaultPathError) {
    return {
      error: {
        code: `vault_path.${error.code}`,
        details: {
          path: error.input,
          reason: error.code,
        },
        message: error.message,
      },
    };
  }

  if (error instanceof VaultListError) {
    return {
      error: {
        code: `vault_list.${error.code}`,
        details: listErrorDetails(error),
        message: error.message,
      },
    };
  }

  return isFilesystemPermissionError(error) ? {
    error: {
      code: "vault_list.permission_denied",
      message: "Filesystem permission denied for this directory",
    },
  } : {
    error: {
      code: "vault_list.internal_error",
      message: "vault_list failed unexpectedly",
    },
  };
}

function listErrorDetails(
  error: VaultListError,
): Readonly<Record<string, number | string>> {
  const details: Record<string, number | string> = {
    path: error.inputPath,
  };

  if (error instanceof VaultDirectoryTooLargeError) {
    details["maxEntries"] = error.maxEntries;
    details["observedAtLeast"] = error.observedAtLeast;
  } else if (error instanceof InvalidVaultListLimitError) {
    details["maxEntries"] = Number.isFinite(error.maxEntries)
      ? error.maxEntries
      : String(error.maxEntries);
  } else if (error instanceof VaultEntryNameNotRepresentableError) {
    details["entryName"] = error.entryName;
    details["reason"] = error.reason;
  }

  return details;
}
