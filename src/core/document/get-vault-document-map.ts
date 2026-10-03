import { projectMap, type HeadingTree } from "markdown-patch";
import { type ReadVaultDocumentOptions, type VaultDocumentReadResult } from "../file/read-vault-document.js";
import { DEFAULT_MAX_DOCUMENT_MAP_HEADINGS, MAX_DOCUMENT_MAP_HEADINGS,
  InvalidDocumentMapHeadingLimitError, MarkdownDocumentMapTooLargeError,
  type DocumentMapLimitOptions } from "./document-map-limits.js";
import { buildVaultMarkdownModel } from "../parser/structured-markdown.js";
import { withoutBom } from "./note-json.js";
import type { ContentVersion } from "../version/content-version.js";

export interface GetVaultDocumentMapOptions extends ReadVaultDocumentOptions, DocumentMapLimitOptions {}
export type VaultDocumentReader = (path: string, options?: ReadVaultDocumentOptions) => Promise<VaultDocumentReadResult>;
export interface VaultDocumentMapResult {
  readonly path: string;
  readonly version: ContentVersion;
  readonly headings: HeadingTree;
  readonly blocks: readonly string[];
  readonly frontmatterFields: readonly string[];
}

export async function getVaultDocumentMap(reader: VaultDocumentReader, path: string, options: GetVaultDocumentMapOptions = {}): Promise<VaultDocumentMapResult> {
  const maximum = options.maxHeadings ?? DEFAULT_MAX_DOCUMENT_MAP_HEADINGS;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_DOCUMENT_MAP_HEADINGS) throw new InvalidDocumentMapHeadingLimitError(maximum);
  const document = await reader(path, options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes });
  const model = buildVaultMarkdownModel(withoutBom(document.content));
  const pending = [...model.root.children];
  let count = 0;
  while (pending.length) {
    const node = pending.pop()!;
    if (++count > maximum) throw new MarkdownDocumentMapTooLargeError(maximum, count);
    pending.push(...node.children);
  }
  const map = projectMap(model);
  return { path: document.path, version: document.version, headings: map.headings, blocks: map.blocks, frontmatterFields: map.frontmatterFields };
}
