import { McpServer, ResourceTemplate, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  VaultBinaryError, type ReadVaultBinaryOptions, type VaultBinaryReference, type VaultBinaryResult,
} from "../../core/binary/read-vault-binary.js";
import { toKnownVaultReadToolErrorPayload } from "./vault-read-errors.js";

export const VAULT_READ_BINARY_TOOL_NAME = "vault_read_binary";
export const MAX_BINARY_LINK_LIFETIME_MS = 15 * 60 * 1000;
export type VaultBinaryReadUseCase = (path: string, options?: ReadVaultBinaryOptions) => Promise<VaultBinaryResult>;

/**
 * Deployment-owned capability: issue a short-lived HTTPS URL for this one file.
 * Used by non-preview auto downloads, explicit links and image preview fallbacks.
 * Required for non-PDF generic attachment delivery, even for small files.
 * The URL must deliver original bytes directly, without an HTML/login wrapper.
 * The download handler must enforce the same caller identity, path sandbox and
 * current filesystem read permissions on every request. When version is present,
 * serve those exact bytes or refuse a changed file. Never publish the Vault root.
 * Reapply core's assertBinaryPath policy at download time, including for old URLs.
 * No URL host, signing key, HTTP server or public-download policy lives in core.
 */
export type VaultBinaryLinkProvider = (file: VaultBinaryReference) => Promise<{
  readonly uri: string;
  readonly expiresAt: string;
}>;

const version = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const base = { path: z.string(), mimeType: z.string(), sizeBytes: z.number().int().nonnegative() };
const output = z.discriminatedUnion("delivery", [
  z.object({ ...base, version, delivery: z.literal("image"), outputMimeType: z.literal("image/webp"),
    outputSizeBytes: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(),
    preview: z.literal(true), firstFrameOnly: z.boolean() }).strict(),
  z.object({ ...base, version, delivery: z.literal("bytes"), uri: z.string() }).strict(),
  z.object({ ...base, version: version.optional(), delivery: z.literal("link"), uri: z.string(), expiresAt: z.string(),
    reason: z.enum(["requested", "download", "too_large", "image_preview_unavailable"]) }).strict(),
]);

export function registerVaultBinaryTool(
  server: McpServer, readBinary: VaultBinaryReadUseCase, createLink?: VaultBinaryLinkProvider,
): void {
  server.registerTool(VAULT_READ_BINARY_TOOL_NAME, {
    description: "Read images and non-PDF attachments. auto: raster preview or signed HTTPS download link. bytes: original data up to 4 MiB. PDF is unsupported in every mode; use the client's native file upload/attachments.",
    inputSchema: z.object({ path: z.string(), as: z.enum(["auto", "bytes", "link"]).optional() }).strict(),
    outputSchema: output,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path, as }): Promise<CallToolResult> => {
    try { return await binaryToolResult(await readBinary(path, as === undefined ? {} : { as }), createLink); }
    catch (error) { return mapVaultBinaryError(error); }
  });

  // Explicit bytes resources contain the whole payload. Clients that choose to read
  // their URI again use the same guarded byte reader and exact-byte version.
  server.registerResource("vault_attachment",
    new ResourceTemplate("obsidian-vault://attachment/{path}?version={version}", { list: undefined }),
    { description: "Version-pinned non-PDF attachment bytes up to 4 MiB; paths are Vault-relative." },
    async (uri) => {
      try {
        const path = decodeURIComponent(uri.pathname.slice(1));
        const expected = uri.searchParams.get("version");
        if (!expected || !version.safeParse(expected).success || uri.href !== binaryResourceUri(path, expected)) {
          throw new BinaryDeliveryError("invalid_resource", "Invalid attachment resource URI");
        }
        const result = await readBinary(path, { as: "bytes" });
        if (result.kind !== "bytes") throw new Error("Unexpected binary reader response");
        if (result.version !== expected) throw new BinaryDeliveryError("version_conflict", "Attachment changed; call vault_read_binary again");
        return { contents: [{ uri: uri.href, mimeType: result.mimeType, blob: result.data.toString("base64") }] };
      } catch (error) {
        const mapped = mapVaultBinaryError(error).structuredContent as { error: { code: string; message: string } };
        // Resource errors are protocol errors, not tool results. Never forward raw exceptions.
        throw new Error(mapped.error.code + ": " + mapped.error.message);
      }
    });
}

async function binaryToolResult(result: VaultBinaryResult, createLink?: VaultBinaryLinkProvider): Promise<CallToolResult> {
  const info: VaultBinaryReference = { path: result.path, mimeType: result.mimeType, sizeBytes: result.sizeBytes,
    ...(result.version === undefined ? {} : { version: result.version }) };
  if (result.kind === "image") {
    return { content: [{ type: "image", data: result.data.toString("base64"), mimeType: result.outputMimeType }],
      structuredContent: { ...info, delivery: "image", outputMimeType: result.outputMimeType,
        outputSizeBytes: result.data.byteLength, width: result.width, height: result.height,
        preview: true, firstFrameOnly: result.firstFrameOnly } };
  }
  if (result.kind === "bytes") {
    const uri = binaryResourceUri(result.path, result.version);
    return { content: [{ type: "resource", resource: { uri, mimeType: result.mimeType, blob: result.data.toString("base64") } }],
      structuredContent: { ...info, delivery: result.kind, uri } };
  }
  if (!createLink) throw new BinaryDeliveryError("link_unavailable",
    "This attachment needs a link (" + result.reason + "); no deployment link provider is configured. See obsidian_help topic binary.");
  let link;
  try { link = await createLink(Object.freeze(info)); }
  catch { throw new BinaryDeliveryError("link_failed", "Attachment link could not be created"); }
  let uri: URL;
  const expiry = Date.parse(link.expiresAt);
  const now = Date.now();
  try { uri = new URL(link.uri); }
  catch { throw new BinaryDeliveryError("invalid_link", "Deployment returned an invalid attachment link"); }
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash ||
      !Number.isFinite(expiry) || expiry <= now || expiry - now > MAX_BINARY_LINK_LIFETIME_MS) {
    throw new BinaryDeliveryError("invalid_link", "Attachment links require HTTPS and an expiry within 15 minutes");
  }
  const expiresAt = new Date(expiry).toISOString();
  return { content: [{ type: "resource_link", uri: uri.href, name: result.path.split("/").at(-1) ?? result.path,
    mimeType: result.mimeType, size: result.sizeBytes, description: "Original attachment; expires " + expiresAt }],
    structuredContent: { ...info, delivery: "link", uri: uri.href, expiresAt, reason: result.reason } };
}

function binaryResourceUri(path: string, version: string): string {
  return "obsidian-vault://attachment/" + encodeURIComponent(path) + "?version=" + encodeURIComponent(version);
}

class BinaryDeliveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BinaryDeliveryError"; }
}

export function mapVaultBinaryError(error: unknown): CallToolResult {
  const known = toKnownVaultReadToolErrorPayload(error);
  let payload: { error: { code: string; message: string; details?: Readonly<Record<string, boolean | number | string>> } };
  if (known) payload = { error: { ...known.error, code: known.error.code.replace(/^vault_read\./u, "vault_read_binary."),
    ...(known.error.code === "vault_read.permission_denied" ? { message: "Filesystem permission denied for this attachment" } : {}) } };
  else if (error instanceof VaultBinaryError || error instanceof BinaryDeliveryError) {
    payload = { error: { code: "vault_read_binary." + error.code, message: error.message } };
  } else payload = { error: { code: "vault_read_binary.internal_error", message: "vault_read_binary failed unexpectedly" } };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}
