# Binary reading and deployment integration

The local implementation adds `vault_read_binary(path, as?)` and a version-pinned
MCP attachment resource template. The stdio composition exposes twelve tools
including help. It has no HTTP listener, signing secret or download endpoint.
Remote transport, authentication and download delivery remain deployment-owned.
Raster previews stay in MCP; other supported attachments use protected,
short-lived HTTPS URLs in `auto`. PDF reading and delivery are intentionally
unsupported. Clients should use their native file upload / attachment feature
for PDFs.

## PDF boundary

Filename MIME lookup identifies PDF paths (`.pdf`, case-insensitive). After the
shared lexical/protected-path validation, every mode (`auto`, `bytes`, `link`)
fails with `vault_read_binary.unsupported_pdf`, before file reads or provider
calls. MCP resource reads use the same core reader, so old version-pinned PDF
resource URIs also fail. The error directs the caller to native client attachments
and offers no mode-based fallback.

The core export `assertBinaryPath(path)` enforces this filename policy. Download
hosts must also call `assertBinaryPath(sandbox.parse(path))` before serving a
signed URL, including one issued by an earlier revision. Signature, expiry,
filesystem and permission checks still apply; this policy does not replace them.
It performs no filesystem access and no PDF parsing.

## Wiring the remote composition

An existing host calling `createVaultMcpServer` must explicitly inject the binary
reader. Copying the package alone does not add the tool to an older composition.

```ts
import { createVaultMcpServer, readVaultBinary } from "obsidian-server-mcp";
import type { VaultBinaryLinkProvider } from "obsidian-server-mcp";

// sandbox and existingDependencies are the host's existing guarded Vault wiring.
// issueAttachmentLink is supplied by the deployment's authenticated delivery layer.
const issueAttachmentLink: VaultBinaryLinkProvider = async (file) => {
  // Implement in the deployment adapter; see the requirements below.
  return downloadService.issueForCurrentCaller(file);
};

const server = createVaultMcpServer({
  ...existingDependencies,
  readBinary: (path, options) => readVaultBinary(sandbox, path, options),
  createBinaryLink: issueAttachmentLink,
});
```

`downloadService` is illustrative host code, not an API shipped by this package.
`createBinaryLink` is required for generic attachment downloads. If it
is omitted, only raster previews and explicit bounded non-PDF `bytes` work; other
`auto`, explicit links and image fallbacks return
`vault_read_binary.link_unavailable`. No missing/failed provider falls back to
inline bytes. PDF always returns `unsupported_pdf`, regardless of provider wiring.

Apply the core PDF policy at download time as well as tool-call time. Refresh
tool discovery and the binary help topic after changing an embedded composition.

## Link provider contract

The provider receives only `{path, mimeType, sizeBytes, version?}` after a guarded
file open and read-access check. `path` is Vault-relative, never an absolute host
path. Non-preview `auto`, explicit `link` and image fallbacks all call this same
provider. The package does not fetch the link or verify its serving implementation.
PDF paths are rejected before the provider is invoked.

- Return `{uri, expiresAt}` with a directly fetchable HTTPS URL and ISO date.
  Fetching the URL must deliver the original bytes, not HTML or an interactive
  login page. MCP carries the locator and metadata, not the downloaded body.
  Expiry must be in the future and at most 15 minutes away. URL credentials and
  fragments are rejected. Native MCP `resource_link` exposes the URL; the
  receipt identifies delivery, expiry and reason (`download`, `requested`,
  `too_large` or `image_preview_unavailable`).
- Issue access for this file and caller only. A signed bearer URL is a temporary
  file capability, not a general Vault URL. Keep signing keys and host details
  in the existing deployment configuration. Never publish a directory/root.
- The download endpoint must resolve the path through the same sandbox and
  recheck current filesystem read permissions on each request, under the same
  intended read identity. It must reject traversal, symlinks, protected entries
  and non-regular files, including changes after URL creation. Do not serve a
  previously resolved absolute path without revalidation.
- Apply the core PDF exclusion on each download request, including valid old
  signatures. Reject it explicitly without returning original bytes or a new
  link. Do not implement a separate PDF route or MIME override in the adapter.
- If `version` is supplied, return those exact original bytes or refuse a changed
  file. If absent, the reference is not a byte snapshot: it describes the file
  inspected at issuance, and the endpoint reads the current authorized file at
  download time. Do not invent an exact-byte hash from filesystem timestamps.
- Non-preview `auto` and explicit `link` use metadata inspection without loading
  or hashing the body, even for small files. Image fallbacks may already have
  read the original bytes and therefore include an exact-byte `version`.
  Bound and stream the endpoint's own transfer; never route a large file through
  the inline 4 MiB byte reader just to issue a link. Apply deployment rate limits
  and response headers suitable for private attachments.
- Failures are returned once without retries. The transport strips raw provider
  exceptions, filesystem roots and stacks from the tool response.

No new upload, copy or download **tool** is introduced. A download endpoint is
still necessary for an HTTPS link to deliver anything; its deployment is separate
from the local stdio implementation.

## Payloads and limits

See `obsidian_help({topic:"binary"})` / the README for user-facing behavior.
Supported non-preview attachments use native MCP `resource_link` content
for the original file's HTTPS download. Images use native MCP `image` content
with an explicitly marked WebP preview. Only explicit `bytes` returns the
original file in a resource `blob`, without any image conversion. It is a bounded
low-level escape hatch for non-PDF files only.
Payload bytes occur only in `content`; `structuredContent` holds metadata.

The inline limits include raw bytes before base64: 4 MiB for explicit bytes
and 1 MiB for an image preview. Their base64 expansion
stays below the installed SDK's default 10 MB stdio message buffer. A lower host
transport cap still needs deployment qualification. Raster preview input is
limited to 64 MiB and 40 million pixels, with a 1568-pixel output edge and a
five-second processing timeout. These are per-call bounds, not a global memory
or concurrency quota. Only PNG/JPEG/GIF/WebP are previewed; other supported
formats select a link in `auto`. Animated previews show the first frame explicitly.

`sharp` is pinned because the runtime needs bounded image decoding, orientation
and scaling. It receives buffers, never Vault filenames, and only recognized
raster signatures. It is not used on PDFs or SVG. Its output omits source
metadata; the source bytes and their SHA-256 version remain unchanged. Install
dependencies on the target platform with the lockfile (`npm ci`) so the native
package matches that host. No system-wide renderer or OCR package is required.

Image API reference: [sharp constructor](https://sharp.pixelplumbing.com/api-constructor/)
and [output options](https://sharp.pixelplumbing.com/api-output/).

## Host validation

Local `npm run check` exercises disposable fixtures, including a real stdio
process and official SDK client. It checks PDF rejection in every mode and
resource reads, generic `resource_link` delivery, provider failures without an
inline fallback, image content, exact
explicit bytes, byte/size bounds, path guards, resource version conflicts and
link-provider validation. Fixture providers return test URLs; they do not prove
production signing, HTTP download enforcement or model ingestion.

After installing and wiring the deployment, validate it with isolated fixtures:

1. Rediscover the configured tools and the `binary` help topic through the
   intended client. A composition matching stock stdio exposes 13 tools, including
   `reference_query`; each optional capability must be wired explicitly.
2. Confirm a fixture image returns a bounded native image preview.
3. Call a PDF with omitted `as` and explicit `auto`, `bytes`, `link`; all must
   return `vault_read_binary.unsupported_pdf` with native-attachment guidance,
   no binary payload and no download link. Check an old PDF resource URI and
   the download endpoint with a valid previously issued PDF signature also refuse.
4. Call a non-PDF generic attachment with `auto` and explicit `link`, fetch the
   signed URLs and compare the original bytes. Check downloads over 4 MiB and
   the explicit `bytes` limit separately.
5. Keep the endpoint's established checks for expiry, tampered signatures,
   permission revocation, protected/traversal/symlink denial (including changes
   after issuance), and changed-file rejection when a version is supplied.
6. Record the version and results. Native client attachments own PDF reading.

A fixture provider does not validate a real download endpoint. Confirm the host's
authorization and delivery behavior before relying on signed links in production.
