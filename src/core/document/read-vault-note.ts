import { readTarget, type ReadScope, type ReadTarget } from "markdown-patch";
import type { VaultDocumentReader } from "./get-vault-document-map.js";
import type { ReadVaultDocumentOptions } from "../file/read-vault-document.js";
import { requireJson, toNoteJson, VaultSemanticError, withoutBom, type JsonValue, type NoteJson } from "./note-json.js";
import { validateMarkdownSource } from "../parser/structured-markdown.js";

export interface ReadVaultNoteOptions extends ReadVaultDocumentOptions {
  readonly targetType?: "heading" | "block" | "frontmatter";
  readonly target?: readonly string[] | string;
  readonly scope?: ReadScope;
}
export type VaultNoteReadResult = (NoteJson & { readonly version: string }) | { readonly path: string; readonly version: string; readonly result: JsonValue };

/** One safe read supplies both the exact-byte token and selected value. */
export async function readVaultNote(reader: VaultDocumentReader, path: string, options: ReadVaultNoteOptions = {}): Promise<VaultNoteReadResult> {
  const { targetType, target, scope, maxBytes } = options;
  if ((targetType === undefined) !== (target === undefined) ||
      (scope !== undefined && targetType === undefined) ||
      (scope !== undefined && !["content", "marker", "markerAndContent"].includes(scope))) {
    throw new VaultSemanticError("invalid_target", "targetType and target must be supplied together; scope requires a target");
  }
  let address: ReadTarget | undefined;
  if (targetType !== undefined) {
    let normalized: unknown = target;
    if (targetType === "heading" && typeof target === "string") {
      try { normalized = JSON.parse(target); } catch { /* The shape check below rejects bare strings. */ }
    }
    if (targetType === "heading" && Array.isArray(normalized) && normalized.every((key: unknown) => typeof key === "string")) {
      address = { targetType, target: normalized as string[] };
    } else if ((targetType === "block" || targetType === "frontmatter") && typeof target === "string") {
      address = { targetType, target };
    } else throw new VaultSemanticError("invalid_target", "Heading targets require a path array; block and frontmatter targets require strings");
    if (scope !== undefined && address) address.scope = scope;
  }
  const document = await reader(path, maxBytes === undefined ? {} : { maxBytes });
  if (!address) return { ...toNoteJson(document), version: document.version };
  const source = withoutBom(document.content);
  validateMarkdownSource(source);
  const result = readTarget(source, address);
  return { path: document.path, version: document.version, result: requireJson(result.kind === "frontmatter" ? result.value : result.content) };
}
