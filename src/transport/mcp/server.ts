import { registerVaultBinaryTool, type VaultBinaryReadUseCase, type VaultBinaryLinkProvider } from "./vault-read-binary.js";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { EngineError } from "markdown-patch";
import { VaultTextError } from "../../core/file/text-policy.js";
import { VaultSemanticError } from "../../core/document/note-json.js";
import { MAX_VAULT_DOCUMENT_BYTES } from "../../core/file/read-vault-document.js";
import type { ReadVaultNoteOptions, VaultNoteReadResult } from "../../core/document/read-vault-note.js";
import type { GetVaultDocumentMapOptions, VaultDocumentMapResult } from "../../core/document/get-vault-document-map.js";
import { MAX_VAULT_LIST_ENTRIES, type ListVaultEntriesOptions } from "../../core/list/list-vault-entries.js";
import { MAX_DOCUMENT_MAP_HEADINGS } from "../../core/document/document-map-limits.js";
import { MAX_SEARCH_QUERY_ENTRIES, MAX_SEARCH_QUERY_FILES, MAX_SEARCH_QUERY_FILE_BYTES, MAX_SEARCH_QUERY_RESULTS, MAX_SEARCH_QUERY_TOTAL_BYTES,
  type SearchVaultQueryOptions, type SearchVaultQueryResultEntry } from "../../core/search/search-vault-query.js";
import { MAX_TAG_LIST_TAGS, type ListVaultTagsOptions, type ListVaultTagsResult } from "../../core/tag/list-vault-tags.js";
import { mapSearchQueryToolError } from "./search-query-errors.js";
import { mapTagListToolError } from "./tag-list-errors.js";
import { mapVaultDocumentMapToolError } from "./vault-document-map-errors.js";
import { mapVaultListToolError } from "./vault-list-errors.js";
import { mapVaultReadToolError } from "./vault-read-errors.js";
import { mapVaultMutationToolError } from "./vault-mutation-errors.js";
import type { VaultMutationStore } from "../../core/mutation/vault-mutations.js";
import { mapObsidianHelpError, readObsidianHelp } from "./obsidian-help.js";
import { registerReferenceQuery, type ReferenceQueryUseCase } from "./reference-query.js";

export const MCP_SERVER_NAME = "obsidian-server-mcp";
export const MCP_SERVER_VERSION = "0.1.0";
export const OBSIDIAN_HELP_TOOL_NAME = "obsidian_help";
export const SEARCH_QUERY_TOOL_NAME = "search_query";
export const TAG_LIST_TOOL_NAME = "tag_list";
export const VAULT_GET_DOCUMENT_MAP_TOOL_NAME = "vault_get_document_map";
export const VAULT_LIST_TOOL_NAME = "vault_list";
export const VAULT_READ_TOOL_NAME = "vault_read";
export const VAULT_WRITE_TOOL_NAME = "vault_write";
export const VAULT_APPEND_TOOL_NAME = "vault_append";
export const VAULT_PATCH_TOOL_NAME = "vault_patch";
export const VAULT_MOVE_TOOL_NAME = "vault_move";
export const VAULT_DELETE_TOOL_NAME = "vault_delete";

const version = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const maxBytes = z.number().int().min(0).max(MAX_VAULT_DOCUMENT_BYTES).optional();
const scanShape = {
  maxEntries: z.number().int().min(1).max(MAX_SEARCH_QUERY_ENTRIES).optional()
    .describe("Optional scanned-entry cap; omit for defaults."),
  maxFiles: z.number().int().min(1).max(MAX_SEARCH_QUERY_FILES).optional()
    .describe("Optional scanned-file cap; omit for defaults."),
  maxFileBytes: z.number().int().min(0).max(MAX_SEARCH_QUERY_FILE_BYTES).optional()
    .describe("Optional per-file byte cap; omit for defaults."),
  maxTotalBytes: z.number().int().min(0).max(MAX_SEARCH_QUERY_TOTAL_BYTES).optional()
    .describe("Optional scanned-byte cap, not response size; omit for defaults."),
};
const headingTree: z.ZodType<Record<string, unknown>> = z.lazy(() => z.record(z.string(), headingTree));
const readOutput = z.union([
  z.object({ path: z.string(), version, content: z.string(), tags: z.array(z.string()), frontmatter: z.record(z.string(), z.json()),
    stat: z.object({ ctime: z.number().finite(), mtime: z.number().finite(), size: z.number().int().nonnegative() }).strict() }).strict(),
  z.object({ path: z.string(), version, result: z.json() }).strict(),
]);

export type VaultReadUseCase = (path: string, options?: ReadVaultNoteOptions) => Promise<VaultNoteReadResult>;
export type VaultListUseCase = (path?: string, options?: ListVaultEntriesOptions) => Promise<{ readonly files: readonly string[] }>;
export type VaultDocumentMapUseCase = (path: string, options?: GetVaultDocumentMapOptions) => Promise<VaultDocumentMapResult>;
export type SearchQueryUseCase = (query: unknown, options?: SearchVaultQueryOptions) => Promise<readonly SearchVaultQueryResultEntry[]>;
export type TagListUseCase = (options?: ListVaultTagsOptions) => Promise<ListVaultTagsResult>;
export interface VaultMcpServerDependencies {
  readonly getDocumentMap: VaultDocumentMapUseCase;
  readonly listEntries: VaultListUseCase;
  readonly readDocument: VaultReadUseCase;
  readonly searchQuery: SearchQueryUseCase;
  readonly tagList: TagListUseCase;
  readonly referenceQuery?: ReferenceQueryUseCase;
  /** Mutations use the shared core store and deployment filesystem permissions. */
  readonly mutations?: VaultMutationStore;
  readonly readBinary?: VaultBinaryReadUseCase;
  readonly createBinaryLink?: VaultBinaryLinkProvider;
}

function semanticError(error: unknown): CallToolResult | undefined {
  if (!(error instanceof VaultTextError || error instanceof VaultSemanticError || error instanceof EngineError)) return undefined;
  const code = error instanceof EngineError ? error.name : error.code;
  const payload = { error: { code: "vault_semantic." + code,
    message: error instanceof EngineError ? "Markdown operation failed: " + error.name : error.message } };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}

export function createVaultMcpServer(dependencies: VaultMcpServerDependencies): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  if (dependencies.referenceQuery) registerReferenceQuery(server, dependencies.referenceQuery);
  function register<I extends z.ZodRawShape>(name: string, description: string, input: z.ZodObject<I>, output: z.ZodType,
    run: (args: z.infer<z.ZodObject<I>>) => Promise<unknown>, mapError: (error: unknown, args: z.infer<z.ZodObject<I>>) => CallToolResult,
    mutation?: { readonly destructive: boolean; readonly idempotent: boolean }): void {
    server.registerTool(name, { description, inputSchema: input, outputSchema: output,
      annotations: { readOnlyHint: mutation === undefined, destructiveHint: mutation?.destructive ?? false,
        idempotentHint: mutation?.idempotent ?? true, openWorldHint: false } },
      async (args): Promise<CallToolResult> => {
        try {
          const result = await run(args as z.infer<z.ZodObject<I>>);
          return { content: [], structuredContent: result as CallToolResult["structuredContent"] };
        } catch (error) { return semanticError(error) ?? mapError(error, args as z.infer<z.ZodObject<I>>); }
      });
  }
  register(OBSIDIAN_HELP_TOOL_NAME, "Usage manual; omit topic for the topic index.",
    z.object({ topic: z.string().optional() }).strict(), z.object({ text: z.string() }).strict(),
    async ({topic}) => readObsidianHelp(topic), mapObsidianHelpError);
  register(VAULT_LIST_TOOL_NAME, 'List a Vault directory; omit path or use "" for root. Directory names end in /. Protected/symlink entries are omitted; overflow errors, never truncation.',
    z.object({ path: z.string().optional(),
      maxEntries: z.number().int().min(1).max(MAX_VAULT_LIST_ENTRIES).optional() }).strict(),
    z.object({ files: z.array(z.string()) }).strict(),
    ({path, maxEntries}) => dependencies.listEntries(path ?? "", maxEntries === undefined ? {} : {maxEntries}), mapVaultListToolError);
  register(VAULT_READ_TOOL_NAME, "Read a Vault text file or target with its version. Discover targets via vault_get_document_map; targeted heading levels are relative. No link graph.",
    z.object({ path: z.string(), maxBytes,
      targetType: z.enum(["heading", "block", "frontmatter"]).optional(),
      target: z.union([z.array(z.string()), z.string()]).optional()
        .describe('Pair with targetType. Heading: full map path, e.g. ["Root","Child"]; block: ID without ^; property: key.'),
      scope: z.enum(["content", "marker", "markerAndContent"]).optional()
        .describe("Requires a target; defaults to content.") }).strict(), readOutput,
    ({path, ...options}) => dependencies.readDocument(path, defined(options) as ReadVaultNoteOptions), mapVaultReadToolError);
  register(VAULT_GET_DOCUMENT_MAP_TOOL_NAME, "Get heading paths, block IDs, property names and exact-byte version. Copy returned keys unchanged for targeted reads/patches.",
    z.object({ path: z.string(), maxBytes, maxHeadings: z.number().int().min(1).max(MAX_DOCUMENT_MAP_HEADINGS).optional() }).strict(),
    z.object({ path: z.string(), version, headings: headingTree, blocks: z.array(z.string()), frontmatterFields: z.array(z.string()) }).strict(),
    ({path, ...options}) => dependencies.getDocumentMap(path, defined(options) as GetVaultDocumentMapOptions), (error, args) => mapVaultDocumentMapToolError(error, args.path));
  register(SEARCH_QUERY_TOOL_NAME, "Query Markdown with JsonLogic over path, content, tags, frontmatter and stat. Returns truthy values. Only scope limits the scan; query path/glob conditions only filter results. Overflow errors, never truncation. No link graph.",
    z.object({ ...scanShape, query: z.record(z.string(), z.json()),
      scope: z.object({ directory: z.string(), recursive: z.boolean() }).strict().optional()
        .describe('Optional scan scope; omit for a recursive whole-Vault scan. directory "" is root; recursive=false scans only direct child files.'),
      maxResults: z.number().int().min(1).max(MAX_SEARCH_QUERY_RESULTS).optional()
        .describe("Optional match cap, not truncation; omit for defaults.") }).strict(),
    z.object({ results: z.array(z.object({ filename: z.string(), version, result: z.json() }).strict()) }).strict(),
    async ({query, ...options}) => ({ results: await dependencies.searchQuery(query, defined(options) as SearchVaultQueryOptions) }), mapSearchQueryToolError);
  register(TAG_LIST_TOOL_NAME, "List tags and parent tags with per-file counts; names omit #. Scan/result limits fail explicitly. Inline recognition may differ from Obsidian Desktop.",
    z.object({ ...scanShape, maxTags: z.number().int().min(1).max(MAX_TAG_LIST_TAGS).optional()
      .describe("Optional unique-tag cap including parents; omit for defaults.") }).strict(),
    z.object({ tags: z.array(z.object({ name: z.string(), count: z.number().int().positive() }).strict()) }).strict(),
    (options) => dependencies.tagList(defined(options) as ListVaultTagsOptions), mapTagListToolError);
  const mutations = dependencies.mutations;
  if (mutations) {
    const mutationOutput = z.object({ message: z.literal("OK"), path: z.string(), version,
      sizeBytes: z.number().int().nonnegative(), created: z.boolean(),
      warnings: z.array(z.object({ code: z.enum(["heading-depth-overflow", "temporary_cleanup_failed"]), message: z.string() }).strict()).optional(),
    }).strict();
    const textInput = z.object({ path: z.string(), content: z.string().max(MAX_VAULT_DOCUMENT_BYTES), ifMatch: version.optional() }).strict();
    register(VAULT_WRITE_TOOL_NAME, "Create or replace UTF-8 text. Existing files require ifMatch; no force bypass. Creates parents. Binary/NUL refused; no automatic retry.",
      textInput, mutationOutput,
      ({ path, content, ifMatch }) => mutations.write(path, content, ifMatch === undefined ? {} : { ifMatch }),
      (error, args) => mapVaultMutationToolError(error, args.path), { destructive: true, idempotent: true });
    register(VAULT_APPEND_TOOL_NAME, "Append UTF-8 text; creates missing files. Existing files require ifMatch; missing final LF is added first. Binary/NUL refused; no automatic retry.",
      textInput, mutationOutput,
      ({ path, content, ifMatch }) => mutations.append(path, content, ifMatch === undefined ? {} : { ifMatch }),
      (error, args) => mapVaultMutationToolError(error, args.path), { destructive: false, idempotent: false });
    const headingAddress = z.array(z.string()).nullable();
    register(VAULT_PATCH_TOOL_NAME, "Patch a heading/block/property with exact-byte ifMatch from a read/map. Copy map keys unchanged. Heading content uses relative levels. No automatic retry.",
      z.object({ path: z.string(), targetType: z.enum(["heading", "block", "frontmatter"]),
        target: z.union([headingAddress, z.string()]), within: z.number().int().optional(),
        operation: z.enum(["replace", "prepend", "append", "delete"]),
        scope: z.enum(["content", "marker", "markerAndContent", "parent"]).optional(),
        content: z.string().max(MAX_VAULT_DOCUMENT_BYTES).optional()
          .describe("Heading target without within: # is a child in content scope, a sibling with markerAndContent prepend/append."),
        value: z.json().optional(),
        destination: z.object({ parent: headingAddress, place: z.union([z.enum(["first", "last"]),
          z.object({ before: headingAddress }).strict(), z.object({ after: headingAddress }).strict()]) }).strict().optional()
          .describe("Heading move only: operation=replace, scope=parent; omit content."),
        ifMatch: version, createTargetIfMissing: z.boolean().optional(), rejectIfContentPreexists: z.boolean().optional(),
      }).strict(), mutationOutput,
      ({ path, ...instruction }) => mutations.patch(path, defined(instruction)),
      (error, args) => mapVaultMutationToolError(error, args.path), { destructive: true, idempotent: false });
    register(VAULT_MOVE_TOOL_NAME, "Move a file; no link/history updates. Creates parents; trailing / retains filename. Overwrite requires allowOverwrite. ifMatch checks source only. No retry or cross-filesystem fallback.",
      z.object({ path: z.string(), destination: z.string(), allowOverwrite: z.boolean().optional(), ifMatch: version.optional() }).strict(),
      z.object({ message: z.literal("OK"), oldPath: z.string(), newPath: z.string() }).strict(),
      ({ path, destination, ...options }) => mutations.move(path, destination, defined(options)),
      (error, args) => mapVaultMutationToolError(error, args.path), { destructive: true, idempotent: false });
    register(VAULT_DELETE_TOOL_NAME, "Delete a file to recoverable Vault .trash; permanent=true is irreversible. ifMatch checks source. No automatic retry or permanent fallback.",
      z.object({ path: z.string(), permanent: z.boolean().optional(), ifMatch: version.optional() }).strict(),
      z.discriminatedUnion("permanent", [
        z.object({ message: z.literal("OK"), path: z.string(), permanent: z.literal(false), trashPath: z.string() }).strict(),
        z.object({ message: z.literal("OK"), path: z.string(), permanent: z.literal(true) }).strict(),
      ]),
      ({ path, ...options }) => mutations.delete(path, defined(options)),
      (error, args) => mapVaultMutationToolError(error, args.path), { destructive: true, idempotent: false });
  }
  if (dependencies.readBinary) registerVaultBinaryTool(server, dependencies.readBinary, dependencies.createBinaryLink);
  return server;
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
