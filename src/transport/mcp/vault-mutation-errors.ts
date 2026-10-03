import type { CallToolResult } from "@modelcontextprotocol/server";
import { VaultMutationError } from "../../core/mutation/vault-mutations.js";
import { InvalidContentVersionError, VersionConflictError } from "../../core/version/content-version.js";
import { isFilesystemPermissionError, toKnownVaultReadToolErrorPayload } from "./vault-read-errors.js";

export function mapVaultMutationToolError(error: unknown, path: string): CallToolResult {
  const knownRead = toKnownVaultReadToolErrorPayload(error);
  const payload = isFilesystemPermissionError(error) ? {
    error: { code: "vault_mutation.permission_denied", message: "Filesystem permissions deny this mutation", details: { path } },
  } : knownRead ?? (error instanceof VaultMutationError ? {
    error: { code: `vault_mutation.${error.code}`, message: error.message,
      details: { path, ...error.details } },
  } : error instanceof VersionConflictError ? {
    error: { code: "vault_mutation.version_conflict", message: error.message,
      details: { path, expected: error.expected, actual: error.actual } },
  } : error instanceof InvalidContentVersionError ? {
    error: { code: "vault_mutation.invalid_version", message: error.message, details: { path } },
  } : {
    error: { code: "vault_mutation.io_error", message: "Mutation failed before publication", details: { path } },
  });
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
