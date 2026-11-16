import { TargetNotFoundError, type DocumentModel, type DocumentRange, type PatchResult, type SectionNode } from "markdown-patch";
import { isDeepStrictEqual } from "node:util";
import type { VaultDocumentReadResult } from "../file/read-vault-document.js";
import { assertTextContent, assertTextPath } from "../file/text-policy.js";
import { requireJson, VaultSemanticError, withoutBom } from "../document/note-json.js";
import { buildVaultMarkdownModel } from "../parser/structured-markdown.js";
import { createHeadingAddressResolver } from "../parser/heading-addresses.js";
import { assertVersionPrecondition, computeContentVersion, parseVersionPrecondition, type VersionPreconditionInput } from "../version/content-version.js";

export const MAX_HEADING_INSERT_INPUT_BYTES = 4 * 1024 * 1024;
export type HeadingInsertionPlace = "first" | "last" |
  { readonly before: readonly string[] } | { readonly after: readonly string[] };
export type VaultHeadingInsertion = VersionPreconditionInput & {
  readonly parent: readonly string[] | null;
  readonly place: HeadingInsertionPlace;
  readonly title: string;
  readonly body: string;
};
export interface PreparedHeadingInsertion extends PatchResult {
  readonly headingPath: readonly string[];
  readonly headingLevel: number;
}

/** Prepare one new section; the store pins the same bytes through publication. */
export function prepareHeadingInsertion(document: VaultDocumentReadResult, input: unknown): PreparedHeadingInsertion {
  requireJson(input);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_HEADING_INSERT_INPUT_BYTES) {
    throw new VaultSemanticError("patch_limit", "Heading insertion input exceeds 4 MiB");
  }
  const value = input as Record<string, unknown> | null;
  const address = (item: unknown): item is string[] => Array.isArray(item) && item.every(key => typeof key === "string");
  const fields = new Set(["parent", "place", "title", "body", "ifMatch", "ifMatchGuard"]);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.has(key)) ||
      !(value["parent"] === null || address(value["parent"])) || typeof value["title"] !== "string" || typeof value["body"] !== "string") {
    throw new VaultSemanticError("invalid_heading_insertion", "Supply an exact parent path (or null for root), place, title and body");
  }
  const place = value["place"];
  if (place !== "first" && place !== "last" && !(place && typeof place === "object" && !Array.isArray(place) &&
      Object.keys(place).length === 1 && Object.entries(place).every(([key, target]) =>
        (key === "before" || key === "after") && address(target) && target.length > 0))) {
    throw new VaultSemanticError("invalid_heading_insertion", "place must be first, last, or before/after an exact direct-child path");
  }
  const instruction = input as VaultHeadingInsertion;
  const precondition = parseVersionPrecondition(instruction);
  if (!precondition) throw new VaultSemanticError("if_match_required", "vault_insert_heading requires ifMatch or ifMatchGuard");
  assertVersionPrecondition(computeContentVersion(document.content), precondition);
  assertTextPath(document.path);
  assertTextContent(document.path, document.content);
  assertTextContent(document.path, instruction.body);
  if (!instruction.title || instruction.title !== instruction.title.trim() || /[\r\n\0]/u.test(instruction.title)) {
    throw new VaultSemanticError("invalid_heading_title", "title must be a nonempty single heading label without surrounding whitespace");
  }
  const source = withoutBom(document.content);
  const model = buildVaultMarkdownModel(source);
  const addresses = createHeadingAddressResolver(model);
  const parent = addresses.resolve(instruction.parent);
  if (!parent) throw new TargetNotFoundError("Parent must be an exact full path from the document map");
  const level = (parent.heading?.level ?? 0) + 1;
  if (level > 6) throw new VaultSemanticError("heading_depth_overflow", "An H6 parent cannot contain another heading");
  if (parent.children.some(child => child.heading!.text === instruction.title)) {
    throw new VaultSemanticError("duplicate_heading", "A direct child already has this title; choose a distinct title");
  }
  let at: number;
  if (instruction.place === "first") at = parent.children[0]?.marker!.start ?? parent.trailingGap.end;
  else if (instruction.place === "last") at = subtreeEnd(parent);
  else {
    const before = "before" in instruction.place;
    const anchor = addresses.resolve(before ? instruction.place.before : instruction.place.after);
    if (!anchor || anchor.parent !== parent) throw new TargetNotFoundError("Placement anchor must be an exact direct child of parent");
    at = before ? anchor.marker!.start : subtreeEnd(anchor);
  }
  const newline = model.lineEnding;
  const { fragment, model: subtree } = prepareSubtree(instruction.title, instruction.body, level, newline);
  const prefix = blankLineGap(source.slice(0, at), newline);
  const inserted = prefix + fragment;
  const next = source.slice(0, at) + inserted + source.slice(at);
  const location = verifyInsertion(model, buildVaultMarkdownModel(next), subtree, parent, at, inserted.length, at + prefix.length);
  const result = (source === document.content ? "" : "\uFEFF") + next;
  assertTextContent(document.path, result);
  return { document: result, warnings: [], ...location };
}

/** Re-level only parser-owned heading markers; ordinary body bytes stay literal. */
function prepareSubtree(title: string, body: string, level: number, newline: string): { fragment: string; model: DocumentModel } {
  // A wrapper prevents a leading --- in body from becoming note frontmatter.
  // Relative H1s may initially be siblings of it, so visit the entire model.
  const relative = "# " + title + newline + (body ? newline + body : "");
  const relativeModel = buildVaultMarkdownModel(relative);
  const headings = sections(relativeModel.root).slice(1);
  const wrapper = headings[0];
  if (wrapper?.heading?.text !== title || wrapper.heading.level !== 1 || wrapper.marker?.start !== 0) {
    throw new VaultSemanticError("invalid_heading_title", "title must round-trip as one exact heading label; omit closing hashes");
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const section of headings) {
    const depth = section === wrapper ? level : level + section.heading!.level;
    if (depth > 6) throw new VaultSemanticError("heading_depth_overflow", "A relative body heading would exceed H6 at this parent");
    const { start, end } = section.marker!;
    const marker = relative.slice(start, end);
    const atx = /^([\t ]{0,3})(#{1,6})(?=[\t \r\n]|$)/u.exec(marker);
    let replacement: string;
    if (atx) {
      replacement = atx[1] + "#".repeat(depth) + marker.slice(atx[0].length);
    } else {
      if (/[\r\n]/u.test(section.heading!.text)) {
        throw new VaultSemanticError("unsupported_heading", "Multiline setext labels cannot be re-levelled losslessly; use a single-line heading label");
      }
      // Single-line setext becomes ATX, keeping its label and original terminator.
      const ending = /(?:\r\n|\r|\n)$/u.exec(marker)?.[0] ?? "";
      replacement = "#".repeat(depth) + " " + section.heading!.text + ending;
    }
    parts.push(relative.slice(cursor, start), replacement);
    cursor = end;
  }
  parts.push(relative.slice(cursor));
  let fragment = parts.join("");
  fragment += blankLineGap(fragment, newline);
  const model = buildVaultMarkdownModel(fragment);
  const rebased = sections(model.root).slice(1);
  if (rebased.length !== headings.length) {
    throw new VaultSemanticError("unsupported_heading", "Heading markers cannot be re-levelled without changing the parsed headings");
  }
  const counterparts = new Map(headings.map((node, index) => [node, rebased[index]!]));
  for (const [index, original] of headings.entries()) {
    const current = rebased[index]!;
    if (current.heading!.text !== original.heading!.text || current.heading!.level !== (index === 0 ? level : level + original.heading!.level)) {
      throw new VaultSemanticError("unsupported_heading", "A re-levelled heading label cannot round-trip exactly; use a representable single-line heading");
    }
    const expectedParent = index === 0 ? model.root :
      original.parent === relativeModel.root ? rebased[0] : counterparts.get(original.parent!);
    if (current.parent !== expectedParent) {
      throw new VaultSemanticError("unsafe_heading_insertion", "Re-levelling would change the relative body heading hierarchy");
    }
    const titles = new Set<string>();
    for (const child of current.children) {
      if (titles.has(child.heading!.text)) {
        throw new VaultSemanticError("duplicate_heading", "The new subtree contains same-title direct siblings; choose distinct sibling titles");
      }
      titles.add(child.heading!.text);
    }
  }
  return { fragment, model };
}

function sections(root: SectionNode): SectionNode[] {
  const result: SectionNode[] = [];
  const visit = (section: SectionNode): void => { result.push(section); section.children.forEach(visit); };
  visit(root);
  return result;
}

function subtreeEnd(section: SectionNode): number {
  let last = section;
  while (last.children.length) last = last.children.at(-1)!;
  return last.trailingGap.end;
}

function blankLineGap(text: string, newline: string): string {
  if (!text || /(?:\r?\n|\r(?!\n))[\t ]*(?:\r?\n|\r(?!\n))$/u.test(text)) return "";
  return /[\r\n]$/u.test(text) ? newline : newline + newline;
}

/** Reject lexical absorption and reparenting before any filesystem staging. */
function verifyInsertion(before: DocumentModel, after: DocumentModel, subtree: DocumentModel, parent: SectionNode,
  at: number, length: number, markerAt: number): Pick<PreparedHeadingInsertion, "headingPath" | "headingLevel"> {
  const unsafe = (): never => { throw new VaultSemanticError("unsafe_heading_insertion",
    "Insertion would change existing structure or the prepared subtree. Check skipped levels and open fence/HTML boundaries; choose another position or edit the source explicitly."); };
  const oldSections = sections(before.root), nextSections = sections(after.root);
  const newSections = sections(subtree.root).slice(1);
  if (nextSections.length !== oldSections.length + newSections.length) unsafe();
  const byMarker = new Map(nextSections.filter(node => node.marker).map(node => [node.marker!.start, node]));
  const shifted = (offset: number): number => offset >= at ? offset + length : offset;
  const counterpart = (node: SectionNode): SectionNode | undefined => node.marker ? byMarker.get(shifted(node.marker.start)) : after.root;
  const sameRange = (old: DocumentRange, next: DocumentRange): boolean => {
    if (old.start < at && old.end > at) return false;
    const delta = old.start >= at ? length : 0;
    return next.start === old.start + delta && next.end === old.end + delta;
  };
  const bodyMatches = (expected: SectionNode, actual: SectionNode,
    rangeMatches: (a: DocumentRange, b: DocumentRange) => boolean): boolean =>
    expected.bodyChildren.length === actual.bodyChildren.length && expected.blocks.length === actual.blocks.length &&
    expected.bodyChildren.every((a, i) => {
      const b = actual.bodyChildren[i]!;
      return a.kind === b.kind && rangeMatches(a.range, b.range);
    }) && expected.blocks.every((a, i) => {
      const b = actual.blocks[i]!;
      return a.id === b.id && a.kind === b.kind && a.isolated === b.isolated && isDeepStrictEqual(a.columns, b.columns) &&
        rangeMatches(a.content, b.content) && rangeMatches(a.marker, b.marker);
    });
  for (const old of oldSections) {
    const next = counterpart(old);
    if (!next || !isDeepStrictEqual(old.heading, next.heading) ||
        (old.parent && next.parent !== counterpart(old.parent)) ||
        (old.marker && (!next.marker || (!sameRange(old.marker, next.marker) &&
          // A terminator-less heading at EOF gains its first line ending from
          // the inserted separator; its label, level and start stay pinned.
          !(old.marker.end === at && next.marker.end > at && next.marker.end <= markerAt)))) ||
        !bodyMatches(old, next, sameRange)) unsafe();
  }
  const insertedCounterpart = (node: SectionNode): SectionNode | undefined => byMarker.get(markerAt + node.marker!.start);
  const insertedRange = (expected: DocumentRange, actual: DocumentRange): boolean =>
    actual.start === markerAt + expected.start && actual.end === markerAt + expected.end;
  for (const expected of newSections) {
    const actual = insertedCounterpart(expected);
    const expectedParent = expected.parent === subtree.root ? counterpart(parent) : insertedCounterpart(expected.parent!);
    if (!actual || !isDeepStrictEqual(actual.heading, expected.heading) || actual.parent !== expectedParent ||
        actual.children.length !== expected.children.length || !actual.marker || !insertedRange(expected.marker!, actual.marker) ||
        !bodyMatches(expected, actual, insertedRange)) unsafe();
  }
  const insertedRoot = byMarker.get(markerAt);
  if (!insertedRoot || !insertedRoot.heading) return unsafe();
  return { headingPath: createHeadingAddressResolver(after).pathOf(insertedRoot), headingLevel: insertedRoot.heading.level };
}
