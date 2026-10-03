import { inspectVaultFile, VaultDocumentNotFoundError, type VaultDocumentReadResult } from "../file/read-vault-document.js";
import { VaultPathError, type VaultPathSandbox } from "../path/vault-path.js";
import { collectVaultCandidates, type VaultMarkdownDocumentReader, type VaultMarkdownScanErrorFactory } from "../traversal/scan-vault-markdown.js";
import { ReferenceParser } from "./reference-parser.js";
import { inScope, matchesTarget, resolveFragment, resolveReference } from "./resolve-reference.js";
import { REFERENCE_LIMITS, ReferenceQueryError, type ReferenceQueryInput, type ReferenceQueryResult,
  type ReferenceOccurrence, type ReferenceScope, type ParsedReferences } from "./types.js";

/** Bounded file inventories and version-pinned source reads; no persistent graph or mutation. */
export async function queryReferences(sandbox: VaultPathSandbox, readDocument: VaultMarkdownDocumentReader,
  input: ReferenceQueryInput): Promise<ReferenceQueryResult> {
  const scope = validateScope(input?.scope, sandbox);
  const resolutionScope = validateScope(input.resolutionScope ?? scope, sandbox);
  const target = input.target;
  if (!target || typeof target.path !== "string" || (target.heading !== undefined && target.block !== undefined) ||
    (target.heading !== undefined && (!Array.isArray(target.heading) || target.heading.length === 0 || target.heading.length > 32 ||
      target.heading.some(item => typeof item !== "string" || !item.trim() || item.length > 1024))) ||
    (target.block !== undefined && (typeof target.block !== "string" || !/^[a-zA-Z0-9-]+$/u.test(target.block)))) {
    throw new ReferenceQueryError("invalid_input", "target");
  }
  sandbox.parse(target.path);
  const limits = Object.fromEntries(Object.entries(REFERENCE_LIMITS).map(([key, bound]) => {
    const value = input[key as keyof typeof REFERENCE_LIMITS] ?? bound.default;
    if (!Number.isInteger(value) || value < 1 || value > bound.max) throw new ReferenceQueryError("invalid_input", key);
    return [key, value];
  })) as Record<keyof typeof REFERENCE_LIMITS, number>;
  let entriesVisited = 0, inventoriedFiles = 0, bytesRead = 0, linksVisited = 0;
  const deadline = Date.now() + 30_000;
  const checkTime = (): void => { if (Date.now() > deadline) throw new ReferenceQueryError("budget_exceeded", "query_time"); };
  const errors: VaultMarkdownScanErrorFactory = {
    budgetExceeded: budget => new ReferenceQueryError("budget_exceeded", budget),
    sourceUnavailable: () => new ReferenceQueryError("scan_failed", "source"),
    traversalChanged: () => new ReferenceQueryError("changed_during_query", "directory"),
    traversalUnavailable: () => new ReferenceQueryError("scan_failed", "directory"),
    unsafeEntryName: () => new ReferenceQueryError("scan_failed", "unsafe_entry"),
  };
  const inventory = async (area: ReferenceScope) => {
    checkTime();
    const collected = await collectVaultCandidates(sandbox, { ...limits,
      maxEntries: limits.maxEntries - entriesVisited, maxFiles: limits.maxFiles - inventoriedFiles }, errors,
      { ...area, includeAttachments: true });
    entriesVisited += collected.state.entriesVisited;
    inventoriedFiles += collected.candidates.length;
    return collected;
  };
  const parser = new ReferenceParser();
  try {
    const resolution = await inventory(resolutionScope);
    const coversSource = resolutionScope.directory === scope.directory && (resolutionScope.recursive || !scope.recursive) ||
      resolutionScope.recursive && (resolutionScope.directory === "" || scope.directory.startsWith(resolutionScope.directory + "/"));
    const sources = coversSource ? resolution : await inventory(scope);
    if (!sources.directories.some(directory => directory === scope.directory)) throw new ReferenceQueryError("scan_failed", "source_scope_not_directory");
    const paths = new Set(resolution.candidates.map(entry => entry.path as string));
    const sourcePaths = sources.candidates.filter(entry => inScope(entry.path, scope) && entry.path.toLowerCase().endsWith(".md"));
    const read = async (path: string): Promise<VaultDocumentReadResult> => {
      checkTime();
      const remaining = limits.maxTotalBytes - bytesRead;
      if (remaining <= 0) throw new ReferenceQueryError("budget_exceeded", "maxTotalBytes");
      const document = await readDocument(path, { maxBytes: Math.min(limits.maxFileBytes, remaining) });
      if (document.path !== path) throw new ReferenceQueryError("scan_failed", "source_path_mismatch");
      bytesRead += document.sizeBytes;
      if (bytesRead > limits.maxTotalBytes) throw new ReferenceQueryError("budget_exceeded", "maxTotalBytes");
      return document;
    };
    let targetDocument: VaultDocumentReadResult | undefined;
    let targetInfo: Awaited<ReturnType<typeof inspectVaultFile>> | undefined;
    let targetParsed: ParsedReferences | undefined;
    try {
      if (target.path.toLowerCase().endsWith(".md")) {
        targetDocument = await read(target.path);
        targetParsed = await parser.parse(targetDocument.content, true);
      } else targetInfo = await inspectVaultFile(sandbox, target.path);
    } catch (error) { if (!(error instanceof VaultDocumentNotFoundError)) throw error; }
    const exists = targetDocument !== undefined || targetInfo !== undefined;
    const requested = exists ? resolveFragment(target, targetParsed) : { status: "unresolved" as const, reason: "file_not_found" };
    const matches: ReferenceOccurrence[] = [], uncertain: ReferenceOccurrence[] = [];
    let outputBytes = 0;
    for (const entry of sourcePaths) {
      checkTime();
      const document = entry.path === target.path && targetDocument ? targetDocument : await read(entry.path);
      const parsed = entry.path === target.path && targetParsed ? targetParsed : await parser.parse(document.content);
      for (const link of parsed.links) {
        checkTime();
        if (++linksVisited > 50_000) throw new ReferenceQueryError("budget_exceeded", "links");
        let resolved = resolveReference(link, document.path, sandbox, paths, resolutionScope, target, exists);
        if (!resolved) continue;
        // Only the requested target needs fragment parsing; other resolved files cannot be its backlinks.
        if (resolved.status === "resolved" && resolved.destination?.path !== target.path) continue;
        if (resolved.destination && (resolved.destination.path === target.path || inScope(resolved.destination.path, resolutionScope))) {
          try { await sandbox.resolve(resolved.destination.path); }
          catch (error) {
            if (error instanceof VaultPathError) resolved = { ...resolved, status: "unsupported", reason: "unsafe_or_protected_path" };
            else throw error;
          }
        }
        if (resolved.status === "resolved" && resolved.destination) resolved = resolveFragment(resolved.destination, targetParsed);
        if (resolved.status === "resolved" && requested.status !== "resolved") resolved = { ...resolved, status: requested.status, reason: "requested_target_" + requested.reason };
        if (resolved.status === "resolved" && !matchesTarget(resolved.destination!, target, targetParsed)) continue;
        const occurrence: ReferenceOccurrence = { ...link, source: { path: document.path, version: document.version }, ...resolved };
        if (matches.length + uncertain.length >= limits.maxResults) throw new ReferenceQueryError("budget_exceeded", "maxResults");
        outputBytes += Buffer.byteLength(JSON.stringify(occurrence), "utf8");
        if (outputBytes > limits.maxOutputBytes) throw new ReferenceQueryError("budget_exceeded", "maxOutputBytes");
        (resolved.status === "resolved" ? matches : uncertain).push(occurrence);
      }
    }
    try {
      if (targetDocument) {
        if ((await read(target.path)).version !== targetDocument.version) throw new ReferenceQueryError("changed_during_query", "target");
      } else {
        const after = await inspectVaultFile(sandbox, target.path);
        if (!targetInfo || JSON.stringify(after) !== JSON.stringify(targetInfo)) throw new ReferenceQueryError("changed_during_query", "target");
      }
    } catch (error) {
      if (!(error instanceof VaultDocumentNotFoundError) || exists) throw error;
    }
    // Check the namespace after the target recheck, without another enumeration.
    // These per-directory witnesses still do not constitute a multi-file transaction.
    await resolution.verify();
    if (sources !== resolution) await sources.verify();
    checkTime();
    const result: ReferenceQueryResult = { target: { ...target, fileExists: exists, status: requested.status, reason: requested.reason, ...(targetDocument ? { version: targetDocument.version } : {}) },
      scope, resolutionScope,
      coverage: { complete: true, incomingOutsideScope: "unknown", atomicSnapshot: false, offsetUnit: "utf16", positionBase: 1,
        sourcesScanned: sourcePaths.length, entriesVisited, bytesRead,
        excluded: ["frontmatter", "code", "comments", "balanced_math", "html", "external_urls", "protected_paths", "symlinks", "non_regular_entries", "non_markdown_sources"] },
      matches, uncertain };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > limits.maxOutputBytes) throw new ReferenceQueryError("budget_exceeded", "maxOutputBytes");
    return result;
  } finally { await parser.close(); }
}

function validateScope(value: ReferenceScope, sandbox: VaultPathSandbox): ReferenceScope {
  if (!value || typeof value.directory !== "string" || typeof value.recursive !== "boolean") throw new ReferenceQueryError("invalid_input", "scope");
  return { directory: sandbox.parse(value.directory, { allowRoot: true }), recursive: value.recursive };
}
