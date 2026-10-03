import { isMap, isScalar, parseDocument, visit } from "yaml";
import type { VaultDocumentReadResult } from "../file/read-vault-document.js";
import { extractDocumentTags } from "../tag/extract-document-tags.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class VaultSemanticError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VaultSemanticError";
  }
}

/** Reject values JSON would silently alter, cycles and expansion bombs. */
export function requireJson(value: unknown, maximumNodes = 100_000): JsonValue {
  let count = 0;
  const ancestors = new Set<object>();
  function check(item: unknown, depth: number): void {
    if (++count > maximumNodes || depth > 64) throw new VaultSemanticError("json_limit", "JSON structure exceeds its bound");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string" && item.isWellFormed()) return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item)) throw new VaultSemanticError("invalid_json", "A finite, acyclic JSON value is required");
    const proto: unknown = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== null && proto !== Object.prototype) throw new VaultSemanticError("invalid_json", "JSON containers must have plain prototypes");
    ancestors.add(item);
    if (Array.isArray(item) && (Object.keys(item).length !== item.length ||
        Object.keys(item).some(key => !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length))) {
      throw new VaultSemanticError("invalid_json", "JSON arrays must not be sparse or have extra properties");
    }
    for (const key of Object.keys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!key.isWellFormed() || !("value" in descriptor)) throw new VaultSemanticError("invalid_json", "JSON must not contain accessors or malformed keys");
      check(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  check(value, 0);
  return value as JsonValue;
}

export function withoutBom(source: string): string {
  return source.startsWith("\uFEFF") ? source.slice(1) : source;
}

export function frontmatterRegion(source: string): { inner: string; start: number; end: number; bodyStart: number } | undefined {
  const opening = /^---(?:\r\n|\n|\r)/u.exec(source);
  if (!opening) return undefined;
  const start = opening[0].length;
  const closing = /^(?:---|\.\.\.)(?:\r\n|\n|\r|$)/mu.exec(source.slice(start));
  if (!closing) throw new VaultSemanticError("invalid_frontmatter", "Frontmatter delimiter is not closed");
  const end = start + closing.index;
  return { inner: source.slice(start, end), start, end, bodyStart: end + closing[0].length };
}

/** Positioned YAML parsing, shared by metadata and source-preserving patching. */
export function parseFrontmatter(source: string) {
  const region = frontmatterRegion(source);
  const doc = parseDocument(region?.inner ?? "", { uniqueKeys: true, strict: true });
  if (doc.errors.length || doc.warnings.length || (doc.contents !== null && !isMap(doc.contents))) {
    throw new VaultSemanticError("invalid_frontmatter", "Frontmatter must be an unambiguous YAML mapping");
  }
  visit(doc, {
    Alias() { throw new VaultSemanticError("unsupported_yaml", "YAML aliases are not supported"); },
    Node(_key, node) {
      if (node.anchor || node.tag) throw new VaultSemanticError("unsupported_yaml", "YAML anchors and explicit tags are not supported");
    },
    Pair(_key, pair) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
        throw new VaultSemanticError("invalid_frontmatter", "Frontmatter keys must be strings");
      }
    },
  });
  const value = requireJson(doc.toJS({ maxAliasCount: 0 }) ?? {});
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new VaultSemanticError("invalid_frontmatter", "Frontmatter must be an object");
  return { region, doc, value };
}

export interface NoteJson {
  readonly path: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly frontmatter: { [key: string]: JsonValue };
  readonly stat: { readonly ctime: number; readonly mtime: number; readonly size: number };
}

export function toNoteJson(document: VaultDocumentReadResult): NoteJson {
  const source = withoutBom(document.content);
  const { region, value: frontmatter } = parseFrontmatter(source);
  const propertyTags = Array.isArray(frontmatter["tags"])
    ? frontmatter["tags"].filter((tag): tag is string => typeof tag === "string") : [];
  const inlineTags = extractDocumentTags(source.slice(region?.bodyStart ?? 0));
  const tags = [...new Set([...propertyTags, ...inlineTags].filter(Boolean).map((tag) => tag.replace(/^#/u, "")))];
  return {
    path: document.path, content: document.content, tags, frontmatter,
    stat: { ctime: document.createdAtMs ?? 0, mtime: document.modifiedAtMs, size: document.sizeBytes },
  };
}
