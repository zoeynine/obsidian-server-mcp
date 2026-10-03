import mime from "mime-types";

export class VaultTextError extends Error {
  constructor(readonly code: "binary_extension" | "nul_byte" | "invalid_unicode", readonly inputPath: string) {
    super(`Text access refused: ${code}`);
    this.name = "VaultTextError";
  }
}

const archives = new Set([
  "application/zip", "application/gzip", "application/tar", "application/zstd",
  "application/x-tar", "application/x-gtar", "application/x-ustar", "application/x-gzip",
  "application/x-compress", "application/x-bzip", "application/x-bzip2", "application/x-xz",
  "application/x-arj", "application/x-stuffit", "application/x-stuffitx", "application/x-iso9660-image",
  "application/vnd.rar", "application/vnd.comicbook-rar", "application/vnd.laszip", "application/vnd.dece.zip",
  "application/pdf", "application/octet-stream", "application/wasm",
]);

/** Local REST 5.3.1 MIME families, applied to reads as well as text mutations. */
export function assertTextPath(path: string): void {
  // Container formats whose MIME names do not advertise their binary encoding.
  if (/\.(?:docx?|xlsx?|pptx?|od[tpfs]|mdb|accdb|sqlite3?|db|exe|dll|class|jar|eot)$/iu.test(path)) {
    throw new VaultTextError("binary_extension", path);
  }
  const type = mime.lookup(path);
  if (!type || (type === "image/svg+xml" && /\.svg$/iu.test(path))) return;
  if (/^(?:image|audio|video|font)\//u.test(type) || /\+(?:zip|gzip)$/u.test(type) ||
      /-compressed$/u.test(type) || archives.has(type)) {
    throw new VaultTextError("binary_extension", path);
  }
}

export function assertTextContent(path: string, content: string): void {
  if (content.includes("\0")) throw new VaultTextError("nul_byte", path);
  if (!content.isWellFormed()) throw new VaultTextError("invalid_unicode", path);
}
