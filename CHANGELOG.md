# Changelog

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
