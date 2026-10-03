import type { VaultPathSandbox } from "../path/vault-path.js";
import type { ParsedReference, ParsedReferences, ReferenceScope, ReferenceTarget, ReferenceStatus } from "./types.js";

export interface Resolution {
  status: ReferenceStatus;
  reason: string;
  destination?: ReferenceTarget;
  candidates?: readonly string[];
}
export function inScope(path: string, scope: ReferenceScope): boolean {
  const prefix = scope.directory ? scope.directory + "/" : "";
  return path.startsWith(prefix) && (scope.recursive || !path.slice(prefix.length).includes("/"));
}
export function fragmentTarget(path: string, fragment: string): ReferenceTarget | undefined {
  if (!fragment) return { path };
  if (fragment.startsWith("^")) return /^[a-zA-Z0-9-]+$/u.test(fragment.slice(1)) ? { path, block: fragment.slice(1) } : undefined;
  if (fragment.includes("=") || fragment.split("#").some(part => !part.trim())) return undefined;
  return { path, heading: fragment.split("#").map(part => part.trim()) };
}
export function resolveReference(link: ParsedReference, source: string, sandbox: VaultPathSandbox,
  inventory: ReadonlySet<string>, scope: ReferenceScope, target: ReferenceTarget, targetExists: boolean): Resolution | undefined {
  if (link.unsupported) return { status: "unsupported", reason: link.unsupported };
  const separator = link.href.indexOf("#");
  let path = separator < 0 ? link.href : link.href.slice(0, separator);
  let fragment = separator < 0 ? "" : link.href.slice(separator + 1);
  if (/^(?:https?|mailto|tel|data|ftp):/iu.test(path) || path.startsWith("//")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return { status: "unsupported", reason: "uri_scheme" };
  if (link.syntax === "markdown") {
    if (/%23/iu.test(fragment)) return { status: "unsupported", reason: "encoded_fragment_separator" };
    try { path = decodeURIComponent(path); fragment = decodeURIComponent(fragment); }
    catch { return { status: "unsupported", reason: "invalid_percent_encoding" }; }
  }
  if (path.includes("\\") || path.includes("\0")) return { status: "unsupported", reason: "unsafe_path" };
  const short = link.syntax === "wikilink" && path !== "" && !path.includes("/");
  if (path && !/\.[^/]+$/u.test(path)) path += ".md";
  if (short) {
    try { sandbox.parse(path); }
    catch { return { status: "unsupported", reason: "unsafe_or_protected_path" }; }
    const candidates = [...inventory].filter(candidate => candidate.slice(candidate.lastIndexOf("/") + 1) === path).sort();
    if (!candidates.includes(target.path) && targetExists && target.path.slice(target.path.lastIndexOf("/") + 1) === path) candidates.push(target.path);
    if (candidates.length > 1) return { status: "ambiguous", reason: "duplicate_filename", candidates: candidates.sort() };
    if (scope.directory !== "" || !scope.recursive) return { status: "unknown", reason: "filename_inventory_is_partial", candidates };
    if (candidates.length === 0) return { status: "unresolved", reason: "filename_not_found" };
    path = candidates[0]!;
  } else {
    const relative = link.syntax === "markdown" || path.startsWith("./") || path.startsWith("../");
    const parts = path === "" ? source.split("/") : path.startsWith("/") ? [] : relative ? source.split("/").slice(0, -1) : [];
    for (const part of (path === "" ? [] : path.split("/"))) {
      if (part === "" || part === ".") continue;
      if (part === "..") { if (!parts.length) return { status: "unsupported", reason: "outside_vault" }; parts.pop(); }
      else parts.push(part);
    }
    path = parts.join("/");
  }
  try { path = sandbox.parse(path); }
  catch { return { status: "unsupported", reason: "unsafe_or_protected_path" }; }
  const destination = fragmentTarget(path, fragment);
  if (!destination) return { status: "unsupported", reason: "fragment_syntax", destination: { path } };
  if (path !== target.path && !inScope(path, scope)) return { status: "unknown", reason: "outside_resolution_scope", destination };
  const exists = path === target.path ? targetExists : inventory.has(path);
  return { status: exists ? "resolved" : "unresolved", reason: exists ? "file" : "file_not_found", destination };
}

/** Conservative anchors: exact plain heading text and block IDs, never opaque map disambiguators. */
export function resolveFragment(destination: ReferenceTarget, parsed: ParsedReferences | undefined): Resolution {
  if (!destination.heading && !destination.block) return { status: "resolved", reason: "file", destination };
  if (!parsed) return { status: "unsupported", reason: "attachment_fragment", destination };
  if (destination.block) {
    const count = parsed.blocks.filter(id => id === destination.block).length;
    return { status: count > 1 ? "ambiguous" : count === 1 ? "resolved" : "unresolved", reason: count > 1 ? "duplicate_block" : count ? "block" : "block_not_found", destination };
  }
  const names = destination.heading!;
  const candidates = parsed.headings.filter(heading => heading.path.length >= names.length &&
    names.every((name, i) => name === heading.path[heading.path.length - names.length + i]));
  const matching = candidates.filter(heading => heading.supported);
  const status = matching.length > 1 ? "ambiguous" : candidates.some(item => !item.supported) ? "unsupported" :
    matching.length === 1 ? "resolved" : parsed.headings.some(item => !item.supported) ? "unsupported" : "unresolved";
  return { status, reason: status === "ambiguous" ? "duplicate_heading" : status === "resolved" ? "heading" :
    status === "unsupported" ? "formatted_heading" : "heading_not_found", destination };
}

export function matchesTarget(destination: ReferenceTarget, target: ReferenceTarget, parsed: ParsedReferences | undefined): boolean {
  if (destination.path !== target.path) return false;
  if (target.block) return destination.block === target.block;
  if (!target.heading) return true;
  if (!destination.heading || !parsed) return false;
  const find = (names: readonly string[]) => parsed.headings.filter(item => item.supported && item.path.length >= names.length &&
    names.every((name, index) => name === item.path[item.path.length - names.length + index]));
  const requested = find(target.heading), linked = find(destination.heading);
  return requested.length === 1 && linked.length === 1 && JSON.stringify(requested[0]!.path) === JSON.stringify(linked[0]!.path);
}
