import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  InvalidVaultDocumentEncodingError,
  InvalidVaultDocumentReadLimitError,
  MAX_VAULT_DOCUMENT_BYTES,
  VaultDocumentNotRegularFileError,
  VaultDocumentReadError,
  VaultDocumentTooLargeError,
} from "../../core/file/read-vault-document.js";
import {
  VaultPathError,
  type VaultPathErrorCode,
} from "../../core/path/vault-path.js";

export type VaultReadToolErrorCode =
  | `vault_path.${VaultPathErrorCode}`
  | `vault_read.${VaultDocumentReadError["code"]}`
  | "vault_read.permission_denied"
  | "vault_read.internal_error";

export type KnownVaultReadToolErrorCode = Exclude<
  VaultReadToolErrorCode,
  "vault_read.internal_error"
>;

export interface VaultReadToolErrorPayload {
  readonly error: {
    readonly code: VaultReadToolErrorCode;
    readonly details?: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
}

export interface KnownVaultReadToolErrorPayload {
  readonly error: {
    readonly code: KnownVaultReadToolErrorCode;
    readonly details?: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
}

/** Maps core failures to stable MCP tool errors without exposing stacks or roots. */
export function mapVaultReadToolError(error: unknown): CallToolResult {
  let payload: VaultReadToolErrorPayload = toKnownVaultReadToolErrorPayload(error) ?? {
    error: {
      code: "vault_read.internal_error" as const,
      message: "vault_read failed unexpectedly",
    },
  };

  if (error instanceof VaultDocumentTooLargeError) {
    const recovery = error.observedSizeBytes <= BigInt(MAX_VAULT_DOCUMENT_BYTES)
      ? `retry with maxBytes >= observedSizeBytes (${error.observedSizeBytes}), up to ${MAX_VAULT_DOCUMENT_BYTES} bytes.`
      : `observedSizeBytes (${error.observedSizeBytes}) exceeds the ${MAX_VAULT_DOCUMENT_BYTES}-byte maximum supported source size.`;
    payload = { error: { ...payload.error,
      message: `${error.message}. maxBytes limits the entire source file, not the selected target; ${recovery}`,
    } };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

/** Returns only recognized path/read failures so other tools can reuse them. */
export function toKnownVaultReadToolErrorPayload(
  error: unknown,
): KnownVaultReadToolErrorPayload | undefined {
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

  if (error instanceof VaultDocumentReadError) {
    return {
      error: {
        code: `vault_read.${error.code}`,
        details: readErrorDetails(error),
        message: error.message,
      },
    };
  }

  if (isFilesystemPermissionError(error)) {
    return {
      error: {
        code: "vault_read.permission_denied",
        message: "Filesystem permission denied for this document",
      },
    };
  }

  return undefined;
}

export function isFilesystemPermissionError(error: unknown): boolean {
  return error instanceof Error && "code" in error &&
    (error.code === "EACCES" || error.code === "EPERM");
}

function readErrorDetails(
  error: VaultDocumentReadError,
): Readonly<Record<string, boolean | number | string>> {
  const details: Record<string, boolean | number | string> = {
    path: error.inputPath,
  };

  if (error instanceof VaultDocumentTooLargeError) {
    details["maxBytes"] = error.maxBytes;
    details["observedSizeBytes"] = error.observedSizeBytes.toString();
  } else if (error instanceof VaultDocumentNotRegularFileError) {
    details["actualType"] = error.actualType;
  } else if (error instanceof InvalidVaultDocumentEncodingError) {
    details["encoding"] = error.encoding;
  } else if (error instanceof InvalidVaultDocumentReadLimitError) {
    details["maxBytes"] = Number.isFinite(error.maxBytes)
      ? error.maxBytes
      : String(error.maxBytes);
  }

  return details;
}
