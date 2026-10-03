import type { CallToolResult } from "@modelcontextprotocol/server";

import {
  InvalidDocumentMapHeadingLimitError,
  MarkdownDocumentMapError,
  MarkdownDocumentMapTooLargeError,
} from "../../core/document/document-map-limits.js";
import {
  toKnownVaultReadToolErrorPayload,
  type KnownVaultReadToolErrorCode,
} from "./vault-read-errors.js";

export type VaultDocumentMapToolErrorCode =
  | KnownVaultReadToolErrorCode
  | `vault_document_map.${MarkdownDocumentMapError["code"]}`
  | "vault_document_map.internal_error";

export interface VaultDocumentMapToolErrorPayload {
  readonly error: {
    readonly code: VaultDocumentMapToolErrorCode;
    readonly details?: Readonly<Record<string, boolean | number | string>>;
    readonly message: string;
  };
}

/** Maps read/parser failures without exposing stacks or the configured root. */
export function mapVaultDocumentMapToolError(
  error: unknown,
  inputPath: string,
): CallToolResult {
  const payload = toPayload(error, inputPath);

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function toPayload(
  error: unknown,
  inputPath: string,
): VaultDocumentMapToolErrorPayload {
  const readPayload = toKnownVaultReadToolErrorPayload(error);
  if (readPayload !== undefined) return readPayload;

  if (error instanceof MarkdownDocumentMapError) {
    return {
      error: {
        code: `vault_document_map.${error.code}`,
        details: documentMapErrorDetails(error, inputPath),
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "vault_document_map.internal_error",
      message: "vault_get_document_map failed unexpectedly",
    },
  };
}

function documentMapErrorDetails(
  error: MarkdownDocumentMapError,
  inputPath: string,
): Readonly<Record<string, number | string>> {
  const details: Record<string, number | string> = { path: inputPath };

  if (error instanceof MarkdownDocumentMapTooLargeError) {
    details["maxHeadings"] = error.maxHeadings;
    details["observedAtLeast"] = error.observedAtLeast;
  } else if (error instanceof InvalidDocumentMapHeadingLimitError) {
    details["maxHeadings"] = Number.isFinite(error.maxHeadings)
      ? error.maxHeadings
      : String(error.maxHeadings);
  }

  return details;
}
