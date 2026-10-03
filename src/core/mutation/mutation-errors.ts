export type VaultMutationErrorCode = "invalid_configuration" | "if_match_required" | "version_conflict" |
  "target_changed" | "unsafe_target" | "temporary_changed" | "cross_device" | "too_large" |
  "permission_denied" | "cleanup_failed" | "not_found" | "destination_exists" | "trash_unavailable" |
  "source_cleanup_failed";

export class VaultMutationError extends Error {
  constructor(readonly code: VaultMutationErrorCode, message: string,
    readonly details: { readonly path?: string; readonly destination?: string } = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultMutationError";
  }
}

export function changed(inputPath: string): VaultMutationError {
  return new VaultMutationError("target_changed", "Mutation target or parent directory changed before publication", { path: inputPath });
}
