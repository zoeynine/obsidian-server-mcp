import type { McpServer, CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { REFERENCE_LIMITS, ReferenceQueryError, type ReferenceQueryInput, type ReferenceQueryResult } from "../../core/reference/types.js";
import { toKnownVaultReadToolErrorPayload } from "./vault-read-errors.js";
export const REFERENCE_QUERY_TOOL_NAME = "reference_query";
export type ReferenceQueryUseCase = (input: ReferenceQueryInput) => Promise<ReferenceQueryResult>;
const scope = z.object({ directory: z.string(), recursive: z.boolean() }).strict();
const target = z.object({ path: z.string(), heading: z.array(z.string().min(1).max(1024)).min(1).max(32).optional(),
  block: z.string().regex(/^[a-zA-Z0-9-]+$/u).optional() }).strict();
const limits = Object.fromEntries(Object.entries(REFERENCE_LIMITS).map(([key, bound]) => [key, z.number().int().min(1).max(bound.max).optional()]));
const occurrence = z.object({ source: z.object({ path: z.string(), version: z.string().regex(/^sha256:[0-9a-f]{64}$/u) }).strict(),
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), line: z.number().int().positive(), column: z.number().int().positive(),
  raw: z.string(), href: z.string(), syntax: z.enum(["wikilink", "markdown"]), embed: z.boolean(), unsupported: z.string().optional(),
  status: z.enum(["resolved", "ambiguous", "unresolved", "unsupported", "unknown"]), reason: z.string(),
  destination: target.optional(), candidates: z.array(z.string()).optional() }).strict();

export function registerReferenceQuery(server: McpServer, run: ReferenceQueryUseCase): void {
  server.registerTool(REFERENCE_QUERY_TOOL_NAME, {
    description: "Find references to a file/heading/block within explicit source and resolution scopes. Read-only; returns matches plus uncertainties and exact source versions. Outside-scope incoming links remain unknown. See help topic references.",
    inputSchema: z.object({ scope, target, resolutionScope: scope.optional(), ...limits }).strict(),
    outputSchema: z.object({ target: target.extend({ fileExists: z.boolean(), status: z.enum(["resolved", "ambiguous", "unresolved", "unsupported", "unknown"]), reason: z.string(), version: z.string().optional() }).strict(), scope, resolutionScope: scope,
      coverage: z.object({ complete: z.literal(true), incomingOutsideScope: z.literal("unknown"), atomicSnapshot: z.literal(false),
        offsetUnit: z.literal("utf16"), positionBase: z.literal(1), sourcesScanned: z.number().int().nonnegative(),
        entriesVisited: z.number().int().nonnegative(), bytesRead: z.number().int().nonnegative(), excluded: z.array(z.string()) }).strict(),
      matches: z.array(occurrence), uncertain: z.array(occurrence) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args): Promise<CallToolResult> => {
    try { return { content: [], structuredContent: await run(args as unknown as ReferenceQueryInput) as unknown as Record<string, unknown> }; }
    catch (error) {
      const payload = error instanceof ReferenceQueryError ? { error: { code: `reference_query.${error.code}`, message: error.message } }
        : toKnownVaultReadToolErrorPayload(error) ?? { error: { code: "reference_query.internal_error", message: "reference_query failed unexpectedly" } };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
    }
  });
}
