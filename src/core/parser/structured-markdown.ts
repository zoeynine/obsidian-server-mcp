import { buildModel, type DocumentModel } from "markdown-patch";
import { parseFrontmatter, VaultSemanticError } from "../document/note-json.js";

/** Guard unsupported YAML before the upstream model can silently reinterpret it. */
export function validateMarkdownSource(source: string): void {
  const { region } = parseFrontmatter(source);
  if (region && source.slice(region.end, region.bodyStart).startsWith("...")) {
    throw new VaultSemanticError("unsupported_yaml", "Structured targeting requires a --- closing delimiter");
  }
}

export function buildVaultMarkdownModel(source: string): DocumentModel {
  validateMarkdownSource(source);
  return buildModel(source);
}
