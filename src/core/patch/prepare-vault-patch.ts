import { buildModel, projectMap, patch, InstructionInputSchema, type InstructionInput, type PatchResult } from "markdown-patch";
import { isMap, isScalar, stringify } from "yaml";
import { isDeepStrictEqual } from "node:util";
import type { VaultDocumentReadResult } from "../file/read-vault-document.js";
import { assertTextContent, assertTextPath } from "../file/text-policy.js";
import { assertVersionPrecondition, computeContentVersion, parseVersionPrecondition, type VersionPreconditionInput } from "../version/content-version.js";
import { parseFrontmatter, requireJson, VaultSemanticError, withoutBom } from "../document/note-json.js";
import { validateMarkdownSource } from "../parser/structured-markdown.js";

export type VaultPatchInstruction = InstructionInput & VersionPreconditionInput & {
  readonly allowSubtreeReplacement?: boolean;
};
export const MAX_PATCH_INPUT_BYTES = 4 * 1024 * 1024;

/** Pure preparation; commit must recheck the same exact-byte precondition. */
export function prepareVaultPatch(document: VaultDocumentReadResult, input: unknown): PatchResult {
  requireJson(input);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_PATCH_INPUT_BYTES) {
    throw new VaultSemanticError("patch_limit", "Patch input exceeds 4 MiB");
  }
  const precondition = input && typeof input === "object"
    ? parseVersionPrecondition(input as VersionPreconditionInput) : undefined;
  if (!precondition) {
    throw new VaultSemanticError("if_match_required", "vault_patch requires ifMatch or ifMatchGuard from the document read");
  }
  assertVersionPrecondition(computeContentVersion(document.content), precondition);
  const allowed = new Set(["targetType", "target", "within", "operation", "scope", "content", "value", "destination", "ifMatch", "ifMatchGuard", "createTargetIfMissing", "rejectIfContentPreexists", "allowSubtreeReplacement"]);
  if (Object.keys(input as object).some(key => !allowed.has(key))) throw new VaultSemanticError("invalid_instruction", "Unknown patch instruction field");
  const { allowSubtreeReplacement = false, ifMatch: _full, ifMatchGuard: _guard, ...engineInput } = input as Record<string, unknown>;
  if (typeof allowSubtreeReplacement !== "boolean") {
    throw new VaultSemanticError("invalid_instruction", "allowSubtreeReplacement must be a boolean");
  }
  let normalized: unknown = engineInput;
  if (engineInput["targetType"] === "heading" && typeof engineInput["target"] === "string") {
    try { normalized = { ...engineInput, target: JSON.parse(engineInput["target"]) }; } catch { /* Schema below rejects bare strings. */ }
  }
  assertTextPath(document.path);
  assertTextContent(document.path, document.content);
  const parsed = InstructionInputSchema.safeParse(normalized);
  if (!parsed.success) throw new VaultSemanticError("invalid_instruction", "Instruction does not match the operation, scope and payload contract");
  const { ifMatch: _ifMatch, ...fields } = parsed.data;
  const instruction = fields as InstructionInput;
  const source = withoutBom(document.content);
  validateMarkdownSource(source);
  protectHeadingSubtree(source, instruction, allowSubtreeReplacement);
  // Never use the engine's short decoded-text hash for filesystem concurrency.
  const output = instruction.targetType === "frontmatter"
    ? patchFrontmatterPreservingSource(source, instruction) : patch(source, instruction);
  const next = (source === document.content ? "" : "\uFEFF") + output.document;
  assertTextContent(document.path, next);
  return { document: next, warnings: output.warnings };
}

function protectHeadingSubtree(source: string, instruction: InstructionInput, allow: boolean): void {
  const replacesSection = instruction.targetType === "heading" && instruction.operation === "replace" &&
    (instruction.scope === undefined || instruction.scope === "content" || instruction.scope === "markerAndContent") &&
    (!("within" in instruction) || instruction.within === undefined);
  if (allow && !replacesSection) {
    throw new VaultSemanticError("invalid_instruction", "allowSubtreeReplacement applies only to heading content or markerAndContent replace without within");
  }
  if (!replacesSection || allow || instruction.targetType !== "heading") return;
  // The public map uses the engine's exact duplicate-heading addresses. Do not
  // guess a target by its label or scan Markdown lines for apparent headings.
  let children = projectMap(buildModel(source)).headings;
  for (const key of instruction.target ?? []) {
    if (!Object.hasOwn(children, key)) return; // Preserve engine not-found/create behavior.
    children = children[key]!;
  }
  if (Object.keys(children).length > 0) {
    throw new VaultSemanticError("subtree_confirmation_required",
      "Heading replacement would remove child sections. To replace the whole subtree, set allowSubtreeReplacement: true with a fresh ifMatch or ifMatchGuard. To edit one body block, use within instead.");
  }
}

function patchFrontmatterPreservingSource(source: string, instruction: InstructionInput): PatchResult {
  if (instruction.targetType !== "frontmatter") throw new Error("Expected frontmatter instruction");
  const before = parseFrontmatter(source);
  if (isMap(before.doc.contents) && before.doc.contents.flow) {
    throw new VaultSemanticError("unsupported_yaml", "Frontmatter patching requires a block mapping to preserve unrelated source");
  }
  const dangerous = (key: string): boolean => ["__proto__", "constructor", "prototype"].includes(key);
  if (Object.keys(before.value).some(dangerous) || dangerous(instruction.target) ||
      ("content" in instruction && dangerous(instruction.content)) ||
      ("value" in instruction && typeof instruction.value === "object" && instruction.value !== null && Object.keys(instruction.value).some(dangerous))) {
    throw new VaultSemanticError("unsafe_key", "Prototype keys cannot be patched");
  }
  // Upstream is the operation/scope/carrier oracle: merge order, creation,
  // collision errors, and null-vs-delete semantics. Only serialization differs.
  const expected = patch(source, instruction);
  const after = parseFrontmatter(expected.document);
  const scope = instruction.scope ?? "content";
  const finish = (document: string): PatchResult => {
    if (!isDeepStrictEqual(parseFrontmatter(document).value, after.value)) {
      throw new VaultSemanticError("unsafe_patch", "Source-preserving patch could not reproduce the requested value");
    }
    return { document, warnings: expected.warnings };
  };
  if (isDeepStrictEqual(before.value, after.value)) return finish(source);
  if (!before.region) return expected;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const render = (key: string, value: unknown): string => stringify(Object.fromEntries([[key, value]]), { lineWidth: 0 }).replace(/\n/gu, newline);
  const pair = isMap(before.doc.contents) ? before.doc.contents.items.find((entry) => isScalar(entry.key) && entry.key.value === instruction.target) : undefined;
  if (!pair || !isScalar(pair.key) || !pair.key.range) {
    const added = Object.keys(after.value).filter((key) => !Object.hasOwn(before.value, key));
    const insertion = added.map((key) => render(key, after.value[key])).join("");
    return finish(source.slice(0, before.region.end) + insertion + source.slice(before.region.end));
  }
  const start = before.region.start + pair.key.range[0];
  const valueRange = pair.value && typeof pair.value === "object" && "range" in pair.value ? pair.value.range : undefined;
  let end = before.region.start + (Array.isArray(valueRange) ? valueRange[2]! : pair.key.range[2]);
  if (!valueRange) {
    const nextLine = source.indexOf("\n", end);
    end = nextLine < 0 ? before.region.end : Math.min(nextLine + 1, before.region.end);
  }
  let replacement: string;
  if (scope === "marker") {
    const newKey = "content" in instruction ? instruction.content : "";
    const keyEnd = before.region.start + pair.key.range[1];
    return finish(source.slice(0, start) + stringify(newKey).trimEnd() + source.slice(keyEnd));
  } else if (scope === "markerAndContent" && (instruction.operation === "prepend" || instruction.operation === "append")) {
    const added = Object.keys(after.value).filter((key) => !Object.hasOwn(before.value, key));
    const insertion = added.map((key) => render(key, after.value[key])).join("");
    const at = instruction.operation === "prepend" ? start : end;
    return finish(source.slice(0, at) + insertion + source.slice(at));
  } else {
    replacement = Object.hasOwn(after.value, instruction.target) ? render(instruction.target, after.value[instruction.target]) : "";
  }
  const result = source.slice(0, start) + replacement + source.slice(end);
  return finish(result);
}
