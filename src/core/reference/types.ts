export interface ReferenceScope { readonly directory: string; readonly recursive: boolean }
export interface ReferenceTarget { readonly path: string; readonly heading?: readonly string[]; readonly block?: string }
export interface ReferenceQueryInput {
  readonly scope: ReferenceScope;
  /** Defaults to scope. Only a recursive root inventory establishes global filename uniqueness. */
  readonly resolutionScope?: ReferenceScope;
  readonly target: ReferenceTarget;
  readonly maxEntries?: number;
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxResults?: number;
  readonly maxOutputBytes?: number;
}
export const REFERENCE_LIMITS = {
  maxEntries: { default: 20_000, max: 200_000 },
  maxFiles: { default: 2_000, max: 10_000 },
  maxFileBytes: { default: 1024 * 1024, max: 4 * 1024 * 1024 },
  maxTotalBytes: { default: 8 * 1024 * 1024, max: 32 * 1024 * 1024 },
  maxResults: { default: 1_000, max: 10_000 },
  maxOutputBytes: { default: 1024 * 1024, max: 4 * 1024 * 1024 },
} as const;
export class ReferenceQueryError extends Error {
  constructor(readonly code: "invalid_input" | "budget_exceeded" | "scan_failed" | "changed_during_query" |
    "parse_limit" | "parse_failed" | "busy", readonly reason: string) {
    super(`reference_query: ${code} (${reason})`);
    this.name = "ReferenceQueryError";
  }
}
export interface ParsedReference {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly column: number;
  readonly raw: string;
  readonly href: string;
  readonly syntax: "wikilink" | "markdown";
  readonly embed: boolean;
  readonly unsupported?: string;
}
export interface ParsedReferences {
  readonly links: readonly ParsedReference[];
  readonly headings: readonly { path: readonly string[]; supported: boolean }[];
  readonly blocks: readonly string[];
}
export type ReferenceStatus = "resolved" | "ambiguous" | "unresolved" | "unsupported" | "unknown";
export interface ReferenceOccurrence extends ParsedReference {
  readonly source: { readonly path: string; readonly version: string };
  readonly status: ReferenceStatus;
  readonly reason: string;
  readonly destination?: ReferenceTarget;
  readonly candidates?: readonly string[];
}
export interface ReferenceQueryResult {
  readonly target: ReferenceTarget & { readonly fileExists: boolean; readonly status: ReferenceStatus; readonly reason: string; readonly version?: string };
  readonly scope: ReferenceScope;
  readonly resolutionScope: ReferenceScope;
  readonly coverage: {
    readonly complete: true;
    readonly incomingOutsideScope: "unknown";
    readonly atomicSnapshot: false;
    readonly offsetUnit: "utf16";
    readonly positionBase: 1;
    readonly sourcesScanned: number;
    readonly entriesVisited: number;
    readonly bytesRead: number;
    readonly excluded: readonly string[];
  };
  readonly matches: readonly ReferenceOccurrence[];
  /** Uncertain occurrences across the source scope, not inferred backlinks. */
  readonly uncertain: readonly ReferenceOccurrence[];
}
