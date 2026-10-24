# Changelog

## 0.2.0 - 2026-10-24

### Added

- Add `vault_replace_text` for atomic replacement of one unique, case-sensitive
  literal string in an existing text file. Overlapping matches count; no match,
  multiple matches, empty `oldText` and unchanged replacements fail explicitly.
  Empty `newText` deletes the match. Replacement preserves original text outside
  the match without newline, BOM or Unicode normalization; the combined input
  limit is 4 MiB. The default full composition now exposes 14 tools.
- Add optional per-instance `toolProfile: "text"` for embedding hosts. It replaces
  `vault_read`, `vault_list`, `vault_get_document_map` and `search_query` with their
  corresponding `_text` names, retaining 14 tools. All text-profile tools omit
  `outputSchema` and `structuredContent` while validating successful output
  internally. Ordinary data and mutation receipts use compact JSON text;
  whole-file and heading/block reads use metadata followed by unchanged text.
  Frontmatter values retain typed JSON, and attachments retain native content
  blocks with leading JSON metadata. The standard stdio profile stays the
  default. Existing `enableTextRead: true` still adds the legacy single-block
  `vault_read_text` to the standard profile, giving 15 tools without changing
  that presentation contract.
- Expand `obsidian_help` with on-demand manuals for every canonical tool and
  text alias, alongside the existing workflow guides. Its index reflects the
  tools exposed by the current endpoint; unknown topics return that index.
  Manuals are bundled at build time and require no runtime Markdown access.
- Add `versionGuard` and mutation input `ifMatchGuard` as shorter version tokens
  to copy from a current read or document map. Full `version` / `ifMatch` remains
  available with its existing exact SHA-256 contract.

### Compatibility and migration

- Heading `vault_patch` replacements of `content` or `markerAndContent`, without
  `within`, now refuse to remove child sections by default with
  `vault_semantic.subtree_confirmation_required`. Set
  `allowSubtreeReplacement: true` only for an intended whole-subtree replacement,
  or use `within` to edit one direct body block while retaining children. The
  confirmation flag is invalid for other edit types; missing-heading errors now
  explain full map paths and body-block indices.
- Write, append, patch and exact-replacement receipts add `beforeSizeBytes`;
  `created` distinguishes a missing file from an existing empty file. Exact
  replacement also returns `replacementCount: 1`. Receipts remain compact and
  do not echo the saved body. Exact replacement does not parse Markdown, but a
  whole-file read still parses frontmatter; it is not a malformed-YAML recovery
  workflow.
- Successful reads, document maps, search results, inspected references and
  text-mutation receipts add `versionGuard` wherever they return `version`.
  Binary results return both tokens only when complete original bytes were
  read; download-only links need not include either. Clients with strict
  success-payload schemas and embedding hosts supplying these results must
  accommodate the added fields.
- A guard is exactly 16 lowercase hexadecimal characters, derived from the
  first 64 bits of the same exact-byte SHA-256 observation. Its initial stale
  check compares only 64 bits rather than the full hash: an unrelated
  pair can collide with probability 2^-64, and birthday collisions become
  plausible around 2^32 distinct versions. Prefer full `ifMatch` when stronger
  collision protection is required. After initial admission, mutations pin the
  full SHA-256 for in-flight revalidation; this does not eliminate a collision
  in the initial short-guard comparison. There is no guard session or cache.
- Pass either `ifMatch` or `ifMatchGuard`, never both. Existing-file write/append
  and every patch/exact replacement require one; move/delete keep their optional
  source precondition. Full-version conflicts retain `expected` / `actual`;
  guard conflicts use the same `vault_mutation.version_conflict` code with
  `expectedGuard` / `actualGuard`. Conflicts require a fresh read and reconciliation;
  mutations are not automatically retried.
- Mapped MCP tool failures now return `isError: true` and one JSON text block
  containing `error.code`, `error.message` and optional `error.details`, without
  `structuredContent`. Clients must read that error block instead of validating
  it against the tool's success output schema. Existing error codes remain;
  new operations and guard validation add their own error cases. Successful
  standard-profile results keep their existing presentation with the added
  fields described above.
- Read `too_large` details now return numeric `observedSizeBytes` through
  `Number.MAX_SAFE_INTEGER`, replacing the previous decimal string. Larger sizes
  use only the decimal-string `observedSizeBytesExact`. `maxBytes` applies to
  the entire source file even for a targeted read or document map; retry only
  when the observed source fits the 64 MiB hard maximum. Recovery messages and
  manuals explain the limit and numeric input to use.

### Distribution and limits

- Source-only GitHub release: clone or extract the source, run `npm ci`, then
  `npm run build`. Keep development dependencies installed for the build. The
  package remains `private: true`; there is no npm publication or prebuilt binary.
- Linux headless servers/VPS remain the supported target with Node.js 22 or
  newer; CI covers Node 22 and 24. Windows remains an optional local development
  environment. Install native dependencies on the target host.
- PDF reading/delivery and Obsidian Desktop UI/link-graph integration remain
  unsupported. Synchronization, remote hosting/authentication and deployment
  permissions remain external responsibilities.

## 0.1.0 - 2026-10-03

First versioned source release of Obsidian Server MCP.

### Included

- Thirteen MCP tools for a headless Obsidian Vault: versioned text and targeted
  reads, document maps, guarded text writes and structured patches, file moves
  and deletion, search, tags, bounded reference queries, non-PDF attachment
  reads, and an on-demand usage manual.
- Vault-relative path and symlink protection, exact-byte versions and `ifMatch`
  checks, atomic text replacement, and explicit scan/result limits.
- English and Simplified Chinese guides, MIT licensing and upstream notices,
  and Linux CI on Node.js 22 and 24.

### Search scope added on 2026-10-03

- `search_query` accepts optional `scope: { directory, recursive }` to scan one
  Vault directory, with or without its subdirectories. Omitting `scope` retains
  the recursive whole-Vault Markdown scan. Query path/glob conditions still
  filter results rather than narrow the scan. `tag_list` and result formats are
  unchanged.

### Distribution and limits

- Source-only GitHub release: clone or extract the source, run `npm ci`, then
  `npm run build`. Node.js 22 or newer is required. The package remains
  `private: true`; this release has no npm publication or prebuilt binaries.
- Linux headless servers/VPS are the supported deployment target. Windows is
  available for local development.
- PDF reading and delivery are unsupported. Obsidian Desktop UI and its link
  graph are unavailable; synchronization, remote hosting and authentication
  remain the responsibility of external deployment adapters.
