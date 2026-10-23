# Obsidian Server MCP

[English](README.md) · [简体中文](README.zh-CN.md)

A lightweight, general Obsidian Server MCP for filesystem and semantic access
to a Vault without a running Obsidian Desktop application. Common tools follow
the pinned Local REST 5.3.1 contract as closely as the filesystem backend permits.

The current entry is stdio. Synchronization, remote transport/authentication and
deployment configuration are external to this implementation. Vault files are
the source of truth; the server sees changes once they reach its filesystem.

The supported deployment target is a **Linux headless server/VPS**. Windows can
be used for local development, but is not a supported deployment platform.

Deployment filesystem permissions are authoritative for what the MCP process
may read, write or delete. Configure access through the environment's user,
group, ACL, mount or container settings. MCP contains no deployment authorization
policy. Local tests use disposable fixtures; Linux filesystem and permissions
validation remains a separate platform qualification.

## Quick start

Install **Node.js 22 or newer** with npm on Linux. CI checks Node 22 and 24.
Download and extract this
repository's source archive, or clone its URL from the repository's **Code** menu.
Open a terminal in the project folder:

```sh
npm ci
npm run build
```

Keep development dependencies installed while building; the TypeScript compiler
is a development dependency. `sharp` installs its native image library for the
current platform, so install dependencies on each host instead of copying
`node_modules` between Windows and Linux.

Start with an empty example Vault. In **Linux bash or sh**:

```sh
mkdir -p ./example-vault
printf '# Hello\n' > ./example-vault/Hello.md
OBSIDIAN_VAULT_ROOT="$PWD/example-vault" node ./dist/stdio-main.js
```

For optional local development in **Windows PowerShell**:

```powershell
New-Item -ItemType Directory -Force ./example-vault | Out-Null
Set-Content -LiteralPath ./example-vault/Hello.md -Value '# Hello' -Encoding utf8
$env:OBSIDIAN_VAULT_ROOT = (Resolve-Path ./example-vault).Path
node ./dist/stdio-main.js
```

A running stdio server waits for MCP messages on standard input; it does not
open a web page or print a ready banner. Stop this manual check with Ctrl+C,
then let your MCP client launch the process itself.

### Connect an MCP client

For clients accepting a `mcpServers` JSON configuration, add this entry and
replace the two absolute paths with your project and Vault paths:

```json
{
  "mcpServers": {
    "obsidian-server": {
      "command": "node",
      "args": ["/absolute/path/obsidian-server-mcp/dist/stdio-main.js"],
      "env": {
        "OBSIDIAN_VAULT_ROOT": "/absolute/path/example-vault"
      }
    }
  }
}
```

For local Windows development, forward-slash paths such as `C:/Projects/obsidian-server-mcp/dist/stdio-main.js`
and `C:/Vaults/example-vault` work in JSON. If your client does not inherit the
terminal's PATH, use the absolute Node executable as `command` (find it with
`(Get-Command node).Source` in PowerShell or `command -v node` on Linux).
Clients with form-based settings use the same command, argument and environment
variable. Launch `node` directly so the MCP protocol has exclusive use of stdout.

Reconnect the client and discover **14 tools**. First call
`obsidian_help({"topic":"read"})`, then `vault_list({"path":""})` and
`vault_read({"path":"Hello.md"})` against the example Vault. A write-capable
client can modify files with this server; choose its Vault and filesystem
permissions accordingly.

If startup fails, check that `npm run build` created `dist/stdio-main.js`, the
Vault directory exists, and the client process receives `OBSIDIAN_VAULT_ROOT`.
No API key or Obsidian Desktop plugin is required for this local stdio entry.
HTTPS hosting, authentication, synchronization and signed attachment downloads
are supplied by a separate deployment adapter. See
[binary integration](docs/binary-read-integration.md) for attachment delivery.

## Architecture and compatibility reference

- `src/core` owns filesystem, path, exact-byte version, parser, query and mutation semantics.
- `src/transport` owns MCP schemas and error/result mapping; it never accesses files directly.
- Tests use disposable fixtures. No build or check connects to a real Vault.

This project references and adapts contracts and implementation patterns from
[Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
by Adam Coddington. The reference is Local REST **5.3.1**, peeled commit
`17a9cfd9ff5dd0156b694bf9b13ab36c786b29da`, not moving main.
See the [pinned parity tables](docs/local-rest-5.3.1-parity.md) for source links,
operation/scope tables, exact dependency rationale, limits and deliberate differences.
This project is distributed under the [MIT License](LICENSE). The upstream
copyright and complete MIT notice are retained in
[third-party notices](THIRD_PARTY_NOTICES.md).

## Implemented MCP tools

Default tools have strict input/output schemas. Text-tool success payloads appear
once in `structuredContent`, with empty content. Attachment payloads appear once
in native MCP `content`, with only metadata in `structuredContent`. Business failures return
`isError: true` and a single JSON text block containing `error.code`, `error.message`
and optional `error.details`. They omit `structuredContent` so the error body is not
validated against the success output schema. Unexpected failures reveal no absolute
filesystem paths or stacks.

| Tool | Behavior |
| --- | --- |
| `obsidian_help` | Topic index when `topic` is omitted; only the requested usage section otherwise |
| `vault_list` | Sorted `{files}` with directory suffixes; omit `path` or use `""` for the Vault root |
| `vault_read` | Whole file or selected heading/block/frontmatter value, with exact-byte version; discover targets with `vault_get_document_map` |
| `vault_read_binary` | Image preview, signed download link or explicit bytes for non-PDF attachments; PDF is unsupported; see `obsidian_help` topic `binary` |
| `vault_get_document_map` | Nested heading addresses, block IDs and frontmatter keys, including duplicate disambiguators |
| `search_query` | JsonLogic over note text, paths and properties, retaining truthy values in `{results}` within scan/result limits |
| `reference_query` | Read-only references to a file/heading/block within explicit source and resolution scopes; matches and uncertainties with source versions |
| `tag_list` | Direct tags and nested parents with per-file counts |
| `vault_write` | Atomic text create/replace; existing files require `ifMatch` or `ifMatchGuard` |
| `vault_append` | Atomic append; existing files require `ifMatch` or `ifMatchGuard`; missing LF added first as in Local REST |
| `vault_patch` | Generic heading/block/frontmatter instruction; requires `ifMatch` or `ifMatchGuard` |
| `vault_replace_text` | Atomic literal replacement of one unique exact string in an existing text file; requires `ifMatch` or `ifMatchGuard` |
| `vault_move` | Move a file; destination suffix and optional `allowOverwrite` follow Local REST |
| `vault_delete` | Recoverable Vault-local trash by default; `permanent: true` permanently deletes a file |

The stdio entry exposes thirteen Vault tools plus the static `obsidian_help` manual.
An embedded read-only composition exposes five text/discovery tools plus help,
can add the binary reader and reference query, and can omit the mutation store. There are no mutation stubs. `search_simple` and
its unused implementation are removed.
Properties use generic patching. Binary upload, copy and Desktop UI tools remain outside this surface.

Properties are edited through `vault_patch(targetType=frontmatter)`; edits
preserve unrelated property text/comments, body, BOM and line endings. YAML
aliases, anchors, duplicate/complex keys and non-JSON values are refused.

Obsidian's Desktop link graph is unavailable and never fabricated. The separate
reference query implements the [bounded filesystem reference contract](docs/reference-query.md).
JsonLogic
supports coercion, arithmetic, collections, defaults, glob and bounded regexp;
it is no longer predicate-only. There is no search database or whole-Vault snapshot.

Operational note: under the current server parser semantics, malformed or
unsupported frontmatter in a single note can make whole-Vault `search_query`
and `tag_list` fail explicitly.

### Optional text-only reading

An embedding host can select a tool profile for each server instance:

| Profile | Reading and navigation tools |
| --- | --- |
| `standard` (default) | `vault_read`, `vault_list`, `vault_get_document_map`, `search_query` |
| `text` | `vault_read_text`, `vault_list_text`, `vault_get_document_map_text`, `search_query_text` |

Each alias shares its original tool's strict input schema, use case, limits,
path policy, error mapping and version semantics. In the text profile, all tools
omit both `outputSchema` and `structuredContent`; successful payloads are still
validated internally. Ordinary data, help and mutation receipts use compact JSON
in one text block. Business errors retain `isError: true` and their existing
payloads. Chinese characters are emitted directly.

`vault_read_text` presents whole-file reads in two text blocks: the first contains
all metadata (`path`, `version`, `versionGuard`, `tags`, `frontmatter`, `stat`) plus
`textField: "content"`; the second is the original `content` string. Heading/block
reads also use two blocks: `{path,version,versionGuard,textField:"result"}` and the reader's
unchanged result string. Empty text remains an empty second block. No trimming,
unescaping, newline conversion or code fences are applied. Frontmatter target
reads retain single-block `{path,version,versionGuard,result}` JSON for every value type,
including strings. Heading/block reads retain their existing semantic behavior,
including relative heading levels; use a whole-file read for exact replacement.

A full composition has 14 tools in either profile. The text profile replaces
the four original names rather than adding duplicate choices. The other ten
names and all operation semantics are shared. The standard profile's output
formats remain unchanged; the standard stdio entry uses that default profile.
Every client discovering an endpoint sees that endpoint's selected tool list.

A host serving clients with different presentation needs can select fixed options
by endpoint while sharing the same Vault dependencies and mutation store:

```ts
const standardServer = createVaultMcpServer(dependencies);
const textServer = createVaultMcpServer(dependencies, {
  toolProfile: "text",
});
```

Use separate MCP server/transport instances for the endpoints. Register options
are local to each instance; the standard instance neither lists nor accepts calls
to the four aliases, and the text instance does not expose their four original
names. The host owns HTTP routing, authentication and resource
discovery; these options do not create routes or separate Vault permissions.
Use the same loaded core module and shared store to retain in-process write
coordination. No client-side hiding is needed. Binary delivery in the text profile
places metadata JSON in the first text block, followed by the unchanged native
image, embedded resource or resource link; attachment bytes are never serialized
into the metadata. Reference queries use compact JSON like other data tools.
Help and recovery instructions refer to the selected profile's available tool
names; stable error codes are unchanged.

For existing hosts, `enableTextRead: true` remains supported: with the default
profile it adds only `vault_read_text`, giving a full composition 15 tools, and
retains the original single-block JSON reading contract.
The text profile already includes that tool and never registers it twice.

### On-demand help

Call `obsidian_help({})` for a compact index with **Guides** and **Tools**.
Guides explain cross-tool workflows; Tools lists the names actually exposed by
this endpoint. Ask for `obsidian_help({"topic":"search_query"})` for one tool's
contract and examples, or `obsidian_help({"topic":"search"})` for its workflow.
All canonical names and the four text-profile names have manuals, including
`obsidian_help` itself. A known manual does not enable an unavailable tool;
its opening notice identifies that situation and any registered counterpart.
Unknown topics return a recoverable error with this endpoint's index. Help
reads no Vault data, makes no network calls and performs no mutations.

The marked guides below and the canonical [tool manual](docs/tool-help.md) are
the documentation sources. Text aliases reuse canonical tool content and add
only presentation notes; they do not maintain separate contracts. Edit these
sources, run `npm run generate:help`, and commit the generated module.
`npm run check:help` detects drift; builds also regenerate it. Runtime help uses
bundled strings, so a deployed package needs neither Markdown source file.

<!-- obsidian-help:read -->
### Finding and reading notes

Start with `vault_list` to discover paths. For a known note, use
`vault_get_document_map` when you need reliable heading paths, block IDs or
property names, then copy its keys unchanged to a targeted `vault_read`.
Use a whole-file read for full context or an exact source slice for replacement.
Targeted heading levels are relative; inspect the whole file or map to verify
stored nesting after a structural change.

Both map and read return the full exact-byte `version` and a 16-hex
`versionGuard`. Copy either `version` into `ifMatch` or `versionGuard` into
`ifMatchGuard` for later mutations, never both. The short guard has lower
collision strength; see guide `write`. A read is not a lock on the note.
If a write reports a conflict, reread and reconcile before another attempt.
`maxBytes` admits the entire source document, even for a small target; narrowing
the target does not bypass file-size limits or frontmatter parsing.

Ask for tool topics `vault_list`, `vault_get_document_map` and `vault_read`
for limits, targeted-read examples and size-error recovery. For attachments use
guide `binary`; for selecting notes use `search`; for edits use `write`.
<!-- /obsidian-help -->

<!-- obsidian-help:binary -->
### Reading attachments

Use `vault_read_binary` for images and non-PDF attachments. Its default
`auto` mode selects a bounded native raster preview or a short-lived protected
HTTPS resource link for another file type. Choose `bytes` only when the client
needs exact bytes within its transfer cap, or `link` when it needs a download.
Generic download delivery requires the embedding host's link provider.

PDF is intentionally unsupported in every mode, including resource reads.
Use the client's native file upload or attachment feature for PDFs. This tool
does not perform OCR or document extraction. Preview metadata identifies a
derived image; it is not evidence that the original bytes were transferred.

Ask for tool topic `vault_read_binary` for exact limits, delivery metadata,
examples and link-unavailable recovery. Guide `paths` applies to attachments
as well as notes.
<!-- /obsidian-help -->

<!-- obsidian-help:search -->
### Searching notes

Choose `search_query` for content/property conditions, `tag_list` for tag
inventory, or `reference_query` for bounded link resolution. A literal content
match can find link-shaped text but does not establish a backlink. Inspect
selected notes with `vault_get_document_map` and targeted or full `vault_read`.

JsonLogic evaluates an expression against each Markdown note. An operator has
one key; combine conditions with `and` or `or`. The returned value is the
expression's truthy result, which may be a boolean or data rather than a snippet.
Use `scope` to choose the scan before adding predicates. A path/glob predicate
filters matches without reducing scan work; `maxTotalBytes` counts scanned
bytes, not response size. Scan and result overflow fail without partial success;
the fixed output cap reports `search_query.budget_exceeded`.

Ask for tool topic `search_query` for fields, operators, limits and runnable
content/frontmatter/compound examples. Guide `tags` explains aggregation;
`references` explains source and resolution coverage.
<!-- /obsidian-help -->

<!-- obsidian-help:references -->
### Finding references to a target

Use `reference_query` when spelling alone cannot decide whether a link points
to a particular file, heading or block. Choose a source `scope` for Markdown
bodies and a `resolutionScope` for the filename inventory used to resolve links.
The inventory defaults to the source scope. A recursive root inventory can
establish uniqueness for a bare wikilink; a partial inventory cannot prove it.

Treat confirmed `matches` separately from `uncertain` occurrences. Uncertain
links may be unrelated to the requested target. Completeness describes only the
declared scopes and supported syntax: incoming links outside the source scope
remain unknown. This is neither a persisted link graph nor an atomic Vault
snapshot. The tool performs no repair or mutation.

Ask for tool topic `reference_query` for target syntax, locators, limits and
examples. Use guide `search` for literal candidate discovery and `read` to
inspect a matched source with its exact version.
<!-- /obsidian-help -->

<!-- obsidian-help:tags -->
### Listing tags

Choose `tag_list` to discover tag names and how many Markdown files contain
each tag. It counts repeated occurrences in a file once and aggregates nested
parents: a note with `a/b` contributes to both `a/b` and `a`.
By contrast, `vault_read` and `search_query` expose only direct tags.
Use `search_query` when you need the matching notes or property conditions.

Tags come from frontmatter and inline hashtags. Inline recognition can differ
from Obsidian Desktop. Scan/tag limits and malformed or unsupported frontmatter
fail explicitly, so an error is not evidence of an empty inventory.

Ask for tool topic `tag_list` for its limits and result example, or
`search_query` for filtering by direct tags.
<!-- /obsidian-help -->

<!-- obsidian-help:patch -->
### Patching headings and properties

Use `vault_get_document_map` to discover an exact semantic target and its
version, then `vault_patch` to edit that heading, block or property with
`ifMatch` or `ifMatchGuard`. Choose a scope before writing content: a section body, its marker,
the whole section or a move of its parent relationship have different effects.
`within: 0` selects the first direct body block when child sections should be
retained; choose the appropriate index for another body block.

Heading content uses relative levels. In the default `content` scope, input
`#` becomes a child of the selected heading. With `markerAndContent`
prepend/append it is relative to the target's actual parent; skipped levels
can change nesting. Whole-subtree replacement with children fails with
`vault_semantic.subtree_confirmation_required` unless explicitly allowed with
`allowSubtreeReplacement: true` as well as a current `ifMatch` or `ifMatchGuard`.

Choose typed `value` for a frontmatter property and `destination` for a
heading move. For a literal exact source edit use `vault_replace_text`; for
literal Markdown at the file end consider `vault_append`.
After a structural edit, check the map or whole-file `vault_read`: targeted
heading reads normalize displayed levels and cannot by themselves prove nesting.

Ask for tool topic `vault_patch` for scope/payload combinations, subtree
recovery and runnable examples. Guide `write` compares the mutation tools.
<!-- /obsidian-help -->

<!-- obsidian-help:write -->
### Writing, appending and replacing text

Choose the operation that matches the intended change:

- `vault_write`: create a text file or replace its entire content.
- `vault_append`: add literal text at the end, creating a missing file.
- `vault_replace_text`: replace one unique literal slice from a whole-file read.
- `vault_patch`: edit a semantic heading, body block or typed property.

For an existing file, read with `vault_read` or `vault_get_document_map` and
copy the returned `versionGuard` unchanged into `ifMatchGuard`. Alternatively,
pass the full `version` as `ifMatch`; its strict exact-match contract is unchanged.
Supply exactly one: both together fail with `vault_mutation.conflicting_preconditions`,
even when they agree. Exact replacement needs the original slice and token from
the same whole-file read. Create with write/append without either token only
when the path is missing. A token for a missing file cannot create it.

`versionGuard` is exactly 16 lowercase hex characters: the first 64 bits of
the same file-byte SHA-256, returned by the server so callers need not slice
or count characters. It has no session, cache, lease, expiry or authorization
meaning. Wrong or stale values conflict; malformed guards are refused. On any
conflict, reread and reconcile rather than copying a token from an error or
automatically retrying. This is content-based, so restoring identical bytes
restores both tokens; neither token tracks intervening edit history.

The short guard is a convenience for non-adversarial edits, not full SHA-256
collision resistance. A random unequal pair collides with probability about
2^-64; birthday collisions become plausible around 2^32 distinct versions.
Use full `ifMatch` when stronger collision resistance is needed. After the
initial check, the server pins the full SHA-256 for in-flight revalidation,
retaining the existing per-path locking and atomic publication limits.

Successful read/map/search/reference results and text-write receipts include
`versionGuard` wherever they include `version`. Binary results include both
only when complete original bytes were read; download-only links need not
have either. Move/delete receipts, directory listings and tag counts gain no
token. Both profiles use the same rules; text reads put the guard in metadata.

Successful receipts report both saved tokens and before/after UTF-8 byte sizes.
They establish that bytes were committed, not that the edit fulfilled its intent
or preserved Markdown structure. Inspect content or a map when that matters.
A saved-note cleanup warning means the write succeeded; do not append again.

Ask for each tool's own topic for its contract and examples. Guide `patch`
covers structured editing, `paths` covers shared path/text limits and `files`
covers moving or deleting files.
<!-- /obsidian-help -->

<!-- obsidian-help:paths -->
## Paths and file limits

All tool paths are untrusted Vault-relative paths. The shared sandbox rejects
absolute, traversing and noncanonical paths, symbolic-link traversal, escape,
reserved Windows names and replacement of the original Vault root. Dot-prefixed
components and host-configured internal subtrees are protected; discovery omits
them and direct access refuses them. The empty string means root only for inputs
that explicitly support it, such as listing and scan directories.

Text operations reject binary extensions, NUL and malformed UTF-8/Unicode while
preserving BOM and original newlines. Read and mutation text sizes default to
4 MiB with a 64 MiB hard cap. Each tool also has its own entry, scan or result
limits; a smaller returned target does not waive whole-source admission.

Deployment filesystem permissions remain authoritative. These safeguards are
not a client authorization policy or a cross-process filesystem lock.
Ask for the relevant tool topic for its parameter limits and actionable errors.
<!-- /obsidian-help -->

The mutation path is deliberately small:

1. Serialize the relative path across store instances in this process; safely
   read existing bytes and require `ifMatch` or `ifMatchGuard` for existing write/append
   and every patch/exact replacement. Validate the prepared text before changing files.
2. Create missing parent directories through the shared sandbox. Write a hidden
   `.obsidian-mcp-<random>.tmp` beside the target using exclusive creation.
   Normal OS creation defaults inherit directory permissions/default ACLs;
   MCP never calls chown/chmod/setfacl or runs a permissions hook.
3. Flush the completed temporary file, close it, and revalidate parents, path,
   temporary identity and the original exact-byte version. No automatic mutation retry.
4. Atomically rename over an existing file. For a missing file, atomic hard-link
   publication refuses a concurrent new destination, then removes the temp name.
   Node rename has no NOREPLACE flag. No unlink-before-replace or copy fallback.

Temporary files are blocked by the same protected-path policy and omitted from
list/search/tag discovery. Failed writes remove their exact temp name after
identity checks. Unsafe/failed cleanup is reported; a successful create with a
leftover temp returns an explicit saved-note warning, not a misleading failure.
Missing parent directories can remain after a failed operation. No startup
orphan sweeper, parent-directory fsync, durability modes or permission manager
is included. A single file fsync is retained before publication; this is not a
power-loss durability guarantee.

New file inodes inherit deployment permissions from the destination directory.
MCP does not preserve/reassign per-file ownership or ACLs. Linux validation must
verify permission inheritance and allowed/denied operations for the actual
process identity and deployment filesystem, including directory permissions
that govern rename and deletion. It must also qualify native symlink/race and
rename behavior. Windows fixtures and injected faults do not validate POSIX ACLs.

Per-path locks are process-local. Final version checks are optimistic checkpoints,
not cross-process filesystem CAS; Sync keeps its own conflict handling. Parent
identities are revalidated, but native Node path calls do not lock directories
against adversarial renames between syscalls. Directory ownership and access
must keep the namespace trusted; the remaining platform behavior is qualified
on each deployment's operating system and filesystem.

Stdio requires only `OBSIDIAN_VAULT_ROOT`; no staging-root or policy-module
configuration is needed. Protocol output uses stdout; diagnostics use stderr.
Write/append/patch/exact-replacement success is a compact `message: "OK"`
receipt with path, exact-byte version, versionGuard, `beforeSizeBytes`, final `sizeBytes`,
`created` and any warnings. Exact replacement adds `replacementCount: 1`;
the note body is not echoed.

<!-- obsidian-help:files -->
## Moving and deleting files

Use `vault_move` to relocate a file and `vault_delete` to delete one.
Neither operation updates incoming links or Obsidian Desktop history.
If link impact matters, inspect it with `reference_query` within declared
scopes before the move; outside-scope incoming links remain unknown.

Move overwrites require `allowOverwrite`. Delete defaults to recoverable
Vault-local trash; `permanent: true` is irreversible. Both accept an optional
`ifMatch` or `ifMatchGuard` for the source, never both (see guide `write`).
Omitting both acts on the current path;
on move it never protects the destination's version. Directories and files
with additional hard links are refused.

Neither tool automatically retries. Trash failure does not fall back to
permanent deletion, and move has no cross-filesystem copy fallback. Recovery
from trash requires filesystem access to the receipt's protected trash path.

Ask for tool topics `vault_move` and `vault_delete` for destination syntax,
receipts, recovery and examples. Guide `paths` describes shared containment.
<!-- /obsidian-help -->

## Requirements and checks

Node.js 22 or newer. Install with `npm ci`; `npm run check` verifies generated
help, typechecks, runs disposable-fixture tests and builds. Individual commands are
`npm run typecheck`, `npm test` and `npm run build`.
GitHub Actions runs the same check on Linux with Node 22 and 24. For ordinary
code changes, run the local check once; there is no required manual OS/Node
matrix. Additional Linux checks depend on the affected behavior or release needs.
The portable test runner discovers compiled test files explicitly and runs
them in separate processes, one file at a time. See [contributing](CONTRIBUTING.md)
for the development workflow.

Pinned parser/JSON/YAML/MIME dependencies are documented in the parity table.
`sharp` is the only additional dependency for bounded raster previews; it does
not render PDFs. See [binary deployment integration](docs/binary-read-integration.md)
for the provider required by generic downloads and deployment acceptance steps.
Tests cover compact transport, targeted reads, frontmatter operations, JsonLogic
values and limits, shared path/text policy, concurrency, exact byte versions,
temp-file/publication ordering, hidden artifacts, races, cleanup and filesystem error propagation.
Binary tests cover PDF rejection across all modes/resources, generic download
links, explicit exact-byte transfer, previews, limits, resource versions,
link-provider boundaries, and a real stdio child process with the MCP SDK client.
