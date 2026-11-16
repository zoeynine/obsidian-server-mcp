import { readTarget, TargetNotFoundError, type ReadScope, type ReadTarget } from "markdown-patch";
import type { VaultDocumentReader } from "./get-vault-document-map.js";
import type { ReadVaultDocumentOptions } from "../file/read-vault-document.js";
import { requireJson, toNoteJson, VaultSemanticError, withoutBom, type JsonValue, type NoteJson } from "./note-json.js";
import { buildVaultMarkdownModel, validateMarkdownSource } from "../parser/structured-markdown.js";
import { createHeadingAddressResolver } from "../parser/heading-addresses.js";
import type { VersionGuard } from "../version/content-version.js";

export interface ReadVaultNoteOptions extends ReadVaultDocumentOptions {
  readonly targetType?: "heading" | "block" | "frontmatter";
  readonly target?: readonly string[] | string;
  readonly scope?: ReadScope;
}
export type VaultNoteReadResult = (NoteJson & { readonly version: string; readonly versionGuard: VersionGuard }) |
  { readonly path: string; readonly version: string; readonly versionGuard: VersionGuard; readonly result: JsonValue };

/** One safe read supplies both the exact-byte token and selected value. */
export async function readVaultNote(reader: VaultDocumentReader, path: string, options: ReadVaultNoteOptions = {}): Promise<VaultNoteReadResult> {
  const { targetType, target, scope, maxBytes } = options;
  if ((targetType === undefined) !== (target === undefined) ||
      (scope !== undefined && targetType === undefined) ||
      (scope !== undefined && !["content", "marker", "markerAndContent"].includes(scope))) {
    throw new VaultSemanticError("invalid_target", "targetType and target must be supplied together; scope requires a target");
  }
  let address: ReadTarget | undefined;
  let headingLabel: string | undefined;
  if (targetType !== undefined) {
    let normalized: unknown = target;
    if (targetType === "heading" && typeof target === "string") {
      try { normalized = JSON.parse(target); } catch { /* Bare strings name raw heading labels. */ }
    }
    if (targetType === "heading" && Array.isArray(normalized) && normalized.every((key: unknown) => typeof key === "string")) {
      address = { targetType, target: normalized as string[] };
    } else if (targetType === "heading" && typeof target === "string") {
      // Only a valid encoded string[] retains the legacy exact-path meaning.
      // Every other string is matched as supplied, without trimming or slugging.
      headingLabel = target;
      address = { targetType, target: [] };
    } else if ((targetType === "block" || targetType === "frontmatter") && typeof target === "string") {
      address = { targetType, target };
    } else throw new VaultSemanticError("invalid_target", "Heading targets require an exact path array or unique raw label string; block and frontmatter targets require strings");
    if (scope !== undefined && address) address.scope = scope;
  }
  const document = await reader(path, maxBytes === undefined ? {} : { maxBytes });
  if (!address) return { ...toNoteJson(document), version: document.version, versionGuard: document.versionGuard };
  const source = withoutBom(document.content);
  if (headingLabel !== undefined) address = { targetType: "heading", target: resolveUniqueHeadingLabel(source, headingLabel),
    ...(scope === undefined ? {} : { scope }) };
  else validateMarkdownSource(source);
  const result = readTarget(source, address);
  return { path: document.path, version: document.version, versionGuard: document.versionGuard,
    result: requireJson(result.kind === "frontmatter" ? result.value : result.content) };
}

function resolveUniqueHeadingLabel(source: string, label: string): string[] {
  const model = buildVaultMarkdownModel(source);
  const addresses = createHeadingAddressResolver(model);
  const candidates: string[][] = [];
  const pending = [...model.root.children].reverse();
  let total = 0;
  while (pending.length) {
    const section = pending.pop()!;
    if (section.heading!.text === label) {
      total++;
      if (candidates.length < 16) candidates.push(addresses.pathOf(section));
    }
    for (let index = section.children.length - 1; index >= 0; index--) pending.push(section.children[index]!);
  }
  if (total === 0) throw new TargetNotFoundError(`Heading label not found: ${JSON.stringify(label)}`);
  if (total > 1) {
    throw new VaultSemanticError("ambiguous_heading",
      "Heading label is not unique. Supply one exact candidate full path array, copying document-map keys unchanged.",
      { candidates, total, truncated: total > candidates.length });
  }
  return candidates[0]!;
}
