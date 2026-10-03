import mime from "mime-types";
import sharp from "sharp";
import type { VaultPathSandbox } from "../path/vault-path.js";
import type { ContentVersion } from "../version/content-version.js";
import {
  inspectVaultFile, readVaultFileBytes, MAX_VAULT_DOCUMENT_BYTES,
  type VaultFileInfo,
} from "../file/read-vault-document.js";

export const MAX_BINARY_BYTES = 4 * 1024 * 1024;
export const MAX_BINARY_IMAGE_BYTES = 1024 * 1024;
export const MAX_BINARY_IMAGE_EDGE = 1568;
export const MAX_BINARY_IMAGE_PIXELS = 40_000_000;
export const MAX_BINARY_IMAGE_SOURCE_BYTES = MAX_VAULT_DOCUMENT_BYTES;

export type VaultBinaryMode = "auto" | "bytes" | "link";
export interface ReadVaultBinaryOptions { readonly as?: VaultBinaryMode }
export interface VaultBinaryReference {
  readonly path: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Present only when the original file's complete bytes have been read. */
  readonly version?: ContentVersion;
}
type InlineReference = VaultBinaryReference & { readonly version: ContentVersion; readonly data: Buffer };
export type VaultBinaryLinkReason = "requested" | "download" | "too_large" | "image_preview_unavailable";
export type VaultBinaryResult =
  | (InlineReference & { readonly kind: "bytes" })
  | (InlineReference & { readonly kind: "image"; readonly outputMimeType: "image/webp";
      readonly width: number; readonly height: number; readonly firstFrameOnly: boolean })
  | (VaultBinaryReference & { readonly kind: "link"; readonly reason: VaultBinaryLinkReason });

export class VaultBinaryError extends Error {
  constructor(readonly code: "invalid_mode" | "unsupported_pdf", readonly inputPath: string) {
    super(code === "unsupported_pdf"
      ? "PDF reading and delivery are intentionally unsupported. Use your client's native file upload or attachment feature."
      : "Binary read mode must be auto, bytes or link");
    this.name = "VaultBinaryError";
  }
}

/** Filename-based product policy, shared with download hosts after sandbox path validation. */
export function assertBinaryPath(inputPath: string): void {
  if (mime.lookup(inputPath) === "application/pdf") throw new VaultBinaryError("unsupported_pdf", inputPath);
}

const previewTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Reads non-PDF attachments only; no OCR, network requests or Vault writes. */
export async function readVaultBinary(
  sandbox: VaultPathSandbox, inputPath: string, options: ReadVaultBinaryOptions = {},
): Promise<VaultBinaryResult> {
  const mode = options.as ?? "auto";
  if (mode !== "auto" && mode !== "bytes" && mode !== "link") throw new VaultBinaryError("invalid_mode", inputPath);
  sandbox.parse(inputPath);
  assertBinaryPath(inputPath);
  const mimeType = mime.lookup(inputPath) || "application/octet-stream";
  if (mode === "bytes") {
    const file = await readVaultFileBytes(sandbox, inputPath, { maxBytes: MAX_BINARY_BYTES });
    return { ...reference(file, mimeType), version: file.version, kind: "bytes", data: file.bytes };
  }

  // Open (rather than stat alone) so filesystem read permissions remain authoritative,
  // including for default downloads and explicit links. Reuse the ordinary reader's guards.
  const info = await inspectVaultFile(sandbox, inputPath);
  const ref = reference(info, mimeType);
  if (mode === "link") return { ...ref, kind: "link", reason: "requested" };

  if (previewTypes.has(mimeType)) {
    if (info.sizeBytes > MAX_BINARY_IMAGE_SOURCE_BYTES) return { ...ref, kind: "link", reason: "too_large" };
    const file = await readVaultFileBytes(sandbox, inputPath, { maxBytes: MAX_BINARY_IMAGE_SOURCE_BYTES });
    const source = { ...reference(file, mimeType), version: file.version };
    const preview = await renderPreview(file.bytes);
    if (!preview) return { ...source, kind: "link", reason: "image_preview_unavailable" };
    return { ...source, kind: "image", ...preview };
  }

  // Original non-preview attachments travel over the host's HTTPS delivery
  // channel, regardless of size. Only explicit bytes loads them into MCP content.
  return { ...ref, kind: "link", reason: "download" };
}

function reference(file: VaultFileInfo, mimeType: string): VaultBinaryReference {
  return { path: file.path, sizeBytes: file.sizeBytes, mimeType };
}

async function renderPreview(bytes: Buffer): Promise<{
  data: Buffer; outputMimeType: "image/webp"; width: number; height: number; firstFrameOnly: boolean;
} | undefined> {
  // Do not pass arbitrary SVG/PDF or path-like data to a native image loader,
  // even when the filename claims to be a raster image.
  if (!hasRasterSignature(bytes)) return undefined;
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_BINARY_IMAGE_PIXELS, failOn: "warning", animated: false });
    const metadata = await image.metadata();
    const { data, info } = await image.rotate()
      .resize({ width: MAX_BINARY_IMAGE_EDGE, height: MAX_BINARY_IMAGE_EDGE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 2 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    if (data.byteLength > MAX_BINARY_IMAGE_BYTES) return undefined;
    return { data, outputMimeType: "image/webp", width: info.width, height: info.height,
      firstFrameOnly: (metadata.pages ?? 1) > 1 };
  } catch {
    // Decoder messages can contain native diagnostics. A preview is optional;
    // only this conversion failure may select a link, never a path/read failure.
    return undefined;
  }
}

function hasRasterSignature(bytes: Buffer): boolean {
  return (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
    (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.length >= 6 && /^GIF8[79]a$/u.test(bytes.toString("ascii", 0, 6))) ||
    (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
}
