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

Reconnect the client and discover **13 tools**. First call
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

All tools have strict input/output schemas. Text-tool success payloads appear
once in `structuredContent`, with empty content. Attachment payloads appear once
in native MCP `content`, with only metadata in `structuredContent`. Known failures return compact
structured errors and a short text equivalent; unexpected failures reveal no
absolute filesystem paths or stacks.

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
| `vault_write` | Atomic text create/replace; existing files require `ifMatch` |
| `vault_append` | Atomic append; existing files require `ifMatch`; missing LF added first as in Local REST |
| `vault_patch` | Generic heading/block/frontmatter instruction; always requires `ifMatch` |
| `vault_move` | Move a file; destination suffix and optional `allowOverwrite` follow Local REST |
| `vault_delete` | Recoverable Vault-local trash by default; `permanent: true` permanently deletes a file |

The stdio entry exposes twelve Vault tools plus the static `obsidian_help` manual.
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

### On-demand help

Call `obsidian_help({})` for a compact topic index, then, for example,
`obsidian_help({"topic":"patch"})` for that section alone. Unknown topics return
a short error with the same topic index. Help reads no Vault data, makes no
network calls and performs no mutations.

The marked sections below are the single source for the bundled help text.
Edit them here, run `npm run generate:help`, and commit the generated module.
`npm run check:help` detects drift; builds also regenerate the module. Runtime
help uses those bundled strings, so a deployed package needs no README file.

<!-- obsidian-help:read -->
### Finding and reading notes

List the Vault root with `vault_list({"path":""})`, or omit `path`. Paths are
Vault-relative; `/` and `.` are not root aliases.

Whole-file reads return `path`, `content`, `tags`, parsed `frontmatter`,
filesystem `stat`, and SHA-256 `version`. Targeted reads return
`{path,version,result}`. `vault_get_document_map` returns the same version plus
heading/block/property addresses, without returning the note body.

`maxBytes` applies to the entire source document, not the selected target.
Targeted reads still read and parse the full source and return its exact-byte
`version`.

To read one section, first call `vault_get_document_map({"path":"note.md"})`.
For `## Setup` inside `# Guide`, pass the full ancestor path to `vault_read`:

```json
{"path":"note.md","targetType":"heading","target":["Guide","Setup"]}
```

Copy every heading key from the returned tree unchanged, including any marker
used to distinguish repeated headings. Block targets use a reference ID without
`^`; frontmatter targets use the property name. `scope` selects part of a target
and requires `targetType` and `target`; it is not a whole-file field selector.

Targeted heading reads express levels relative to their scope. Use the map or
a whole-file read to verify actual nesting after a structural edit.
<!-- /obsidian-help -->

<!-- obsidian-help:binary -->
### Reading attachments

`vault_read_binary({path, as?: "auto" | "bytes" | "link"})` accepts the same
Vault-relative paths and filesystem permissions as text reads. It performs no
OCR, upload or Vault mutation. MIME type is inferred from
the filename, with `application/octet-stream` for unknown extensions.

**PDF is intentionally unsupported for both reading and delivery.** PDF paths
(`.pdf`, case-insensitive) return `vault_read_binary.unsupported_pdf` in every
mode, including `bytes`, and through MCP resource reads. Use the client's native
file upload / attachment feature for PDFs; changing `as` does not enable them.

- `auto` (default): PNG/JPEG/GIF/WebP become a native MCP image preview.
  The first frame is auto-oriented and resized without enlargement to at most
  1568 pixels on either edge. The WebP preview is at most 1 MiB, with a 40-million
  input-pixel guard, 64 MiB source-byte cap and five-second processing timeout.
  Metadata marks it as a preview and reports whether only the first frame was
  returned. The original file is unchanged; use `bytes` for its exact bytes.
- `auto` for other non-PDF files returns a signed HTTPS download link,
  even for small or empty files. SVG and other image formats also use this path;
  they are not rasterized. The original bytes travel over HTTPS rather than
  being embedded in the tool result. The client must fetch the URL to read them.
- Oversized or unavailable image previews also select a link.
  `as: "link"` requests a download link directly, including for raster images.
- `as: "bytes"` returns original bytes as a binary resource, with an inclusive
  4 MiB hard cap. It never converts, truncates or silently falls back to a link.
  This is an explicit low-level option for supported non-PDF attachments.

Payload appears once in MCP `content` (image, embedded resource or resource link);
`structuredContent` contains only delivery metadata. Inline results carry an
exact-byte source `version`. The `bytes` result's `obsidian-vault://attachment/…` URI
can be re-read through MCP resources with the same 4 MiB cap and version check;
it is not a browser/download URL. Resource reads do not enumerate attachments.

Links require a deployment-provided, short-lived HTTPS download URL. Stock
stdio has no link provider and returns `vault_read_binary.link_unavailable`
for non-PDF `auto` downloads, explicit links and image fallbacks. Links must
expire within 15 minutes and deliver the original file without a login page.
Non-preview `auto` and explicit `link` inspect the source without loading or
hashing its body, so no content version is claimed. An unversioned link refers
to the current file at download time; an image fallback with a source `version`
must deliver those exact bytes or reject a changed file. The download handler
must recheck path protection, current read access and the PDF exclusion,
including for previously issued links. No automatic retries occur.

Examples:

```json
{"path":"Attachments/diagram.png"}
{"path":"Attachments/archive.zip"}
{"path":"Attachments/archive.zip","as":"bytes"}
{"path":"Attachments/recording.mp4","as":"link"}
```
<!-- /obsidian-help -->

<!-- obsidian-help:search -->
### Searching notes

`search_query` can use these fields with JsonLogic `var`:

| Field | Value |
| --- | --- |
| `path` | Vault-relative file path, such as `projects/plan.md` |
| `content` | Complete Markdown text, including frontmatter |
| `tags` | Direct frontmatter and inline tags, without `#` or added parent tags |
| `frontmatter` | Parsed properties; use dot notation such as `frontmatter.status` |
| `stat` | `ctime` and `mtime` in milliseconds, `size` in bytes |

Optional `scope` limits the scan to a Vault-relative `directory` (`""` is the
root). Both `directory` and `recursive` are required when scope is provided:
`recursive: false` scans only direct child files; `true` includes subdirectories.
Omitting scope keeps the recursive whole-Vault Markdown scan.

Budget parameters on `search_query` and `tag_list` are optional. Normally omit
them to use default limits; set them when you intentionally want custom hard
limits. For example, scan only `projects/` and its subdirectories for `needle`,
choosing a limit of 50 matches:

```json
{
  "scope": {"directory": "projects", "recursive": true},
  "query": {"in": ["needle", {"var": "content"}]},
  "maxResults": 50
}
```

Only `scope` limits which files the server scans. Query path/glob conditions
filter returned matches without pruning the scan; glob `*` also matches nested
directories. `maxTotalBytes` limits scanned bytes, not response size.
Exceeding a scan or result limit returns an error
instead of partial results. Each match contains `filename`, `version` and the
query's truthy `result` value; this example returns `true`, not a text snippet.

Results also have a fixed 4 MiB output budget, including conservative per-result
overhead. Overflow returns `search_query.budget_exceeded` with
`budget: "maxOutputBytes"`; this budget is not a configurable input parameter.

`links`, `backlinks` and `unresolvedLinks` are unavailable. To find possible
references, search `content` for literal link text, for example
`{"query":{"in":["[[Note",{"var":"content"}]}}`. Inspect candidates with
`vault_get_document_map` and targeted `vault_read`; a text match does not resolve
links and may miss other link spellings or match longer names.

JsonLogic supports comparisons, logic, string/collection/arithmetic operators,
plus `glob` and `regexp`. Unsafe prototype access and the `log` operator are
rejected. Malformed or unsupported frontmatter in any scanned note fails the
query explicitly.

An operator expression has exactly one key. Objects with multiple keys are
literal data in JsonLogic; for example, `{"a":1,"b":2}` is a truthy result for
every scanned note, not two conditions. Combine conditions with `and` or `or`.
<!-- /obsidian-help -->

<!-- obsidian-help:references -->
### Finding references to a target

`reference_query` is a separate read-only tool. Specify where to scan Markdown
bodies, whether to recurse, and the exact Vault-relative target file:

```json
{
  "scope": {"directory": "projects", "recursive": true},
  "resolutionScope": {"directory": "", "recursive": true},
  "target": {"path": "notes/Design.md"}
}
```

`resolutionScope` inventories filenames, including attachments; it does not
read every note body. It defaults to `scope`. Bare wikilinks such as `[[Design]]`
need a recursive root inventory to establish uniqueness among accessible files.
A unique candidate in a partial inventory remains `unknown`; duplicate candidates
are `ambiguous`. Explicit paths to the requested target can resolve outside that
inventory. The target is inspected/read even when outside the source scope.

To query a section, use `target: {"path":"notes/Design.md","heading":["Overview"]}`;
for a block, use `target: {"path":"notes/Design.md","block":"decision"}`. Do not
combine heading and block. Heading texts are case-sensitive, plain, consecutive
ancestor names; duplicate anchors are ambiguous, not selected by map suffixes.

`matches` contains confirmed references. `uncertain` contains ambiguous,
unresolved, unsupported or unknown occurrences across the source scope; these
may be unrelated to the target and are not inferred backlinks. Each occurrence
includes source path/version, raw link, parsed destination when available,
zero-based half-open UTF-16 offsets and one-based line/UTF-16 column.
`target.fileExists` describes the file; `target.status` separately describes the
requested file/heading/block. Target Markdown carries its exact-byte version.

Supports ordinary wikilinks and CommonMark inline/reference links, display aliases
and embeds. Frontmatter aliases do not add filename candidates. Attachments are
checked for existence only; page/time fragments are unsupported, and this does
not enable PDF reading. Formatted heading anchors are conservative/unsupported.
Frontmatter, code, comments, balanced math, HTML and external URLs are excluded.

Completeness covers only the declared scopes and supported syntax. Incoming
links outside the source scope remain `unknown`; this is not an atomic Vault
snapshot. Defaults/hard maxima: entries 20,000/200,000; inventoried files
2,000/10,000; per-file bytes 1/4 MiB; total read bytes 8/32 MiB; returned matches
plus uncertainties 1,000/10,000; JSON output 1/4 MiB. Override with `maxEntries`,
`maxFiles`, `maxFileBytes`, `maxTotalBytes`, `maxResults`, `maxOutputBytes`.
The final target recheck counts toward total read bytes. Parsing also has worker,
time and structural limits. Overflow, scan failure or detected namespace/target
change fails the call; no partial success, mutation, repair or automatic retry.
<!-- /obsidian-help -->

<!-- obsidian-help:tags -->
### Listing tags

`tag_list({})` returns tags from Markdown files with a count of files containing
each tag. Names omit `#`; repeated occurrences in one file count once. Nested
parents are included: `a/b` also counts toward `a`. By contrast, `vault_read`
and `search_query` expose direct tags without adding parents.

Tags come from frontmatter `tags` and inline hashtags. Inline recognition may
differ from Obsidian Desktop. Budget arguments are optional; normally omit them
to use defaults. `maxTags` counts unique names including parents. Scan or tag
limit overflow fails explicitly, without returning a truncated list. Malformed
or unsupported frontmatter also fails the scan.
<!-- /obsidian-help -->

<!-- obsidian-help:patch -->
### Patching headings and properties

Call `vault_get_document_map` first to discover exact heading paths and obtain
the file's current exact-byte `version` for `ifMatch`. The map returns that
version without returning the whole note text. Replace `<current version>` in
each example below with the version from the latest map or read of `note.md`.

Use `content` for Markdown or label edits, `value` for frontmatter property
values, or `destination` for heading moves; do not combine these payloads.
`delete` takes no payload. With `scope: "marker"`, supply only the new label,
without heading `#` markers. Conflicts and failures are not automatically retried.

These examples are independent. For a note with `# Root`, `## A` and `## B`,
replace the content of `A` while keeping its heading:

```json
{
  "path": "note.md",
  "targetType": "heading",
  "target": ["Root", "A"],
  "operation": "replace",
  "scope": "content",
  "content": "New body.",
  "ifMatch": "<current version>"
}
```

Set the `status` property, creating it if missing. Use `value`, not `content`;
omit `createTargetIfMissing` when a missing property should be an error:

```json
{
  "path": "note.md",
  "targetType": "frontmatter",
  "target": "status",
  "operation": "replace",
  "value": "ready",
  "createTargetIfMissing": true,
  "ifMatch": "<current version>"
}
```

When `vault_patch` targets a heading section, omit `within`. Heading markers in
`content` are relative to the selected heading and scope, not absolute Markdown
levels. `within` instead selects a body block for a block edit.

| Scope and operation | Meaning of content starting with `#` |
| --- | --- |
| `content` (default), `replace` / `prepend` / `append` | A direct child of the selected heading |
| `markerAndContent`, `prepend` / `append` | A sibling section before / after the selected section and its descendants |

For example, with `# Root` containing `## A` and `## B`, insert a new sibling
section immediately after `A` by calling `vault_patch` with:

```json
{
  "path": "note.md",
  "targetType": "heading",
  "target": ["Root", "A"],
  "operation": "append",
  "scope": "markerAndContent",
  "content": "# Inserted",
  "ifMatch": "<current version>"
}
```

The stored order is `## A`, `## Inserted`, `## B`. Use `prepend` to insert before
`A`. With the default `content` scope, `# Inserted` would instead become
`### Inserted` inside `A`; `## Inserted` would become `#### Inserted`.

`destination` moves an existing heading section. For example, to move `A`
under `B` as its last child, use `operation: "replace"` and `scope: "parent"`
with a fresh version and no `content`:

```json
{
  "path": "note.md",
  "targetType": "heading",
  "target": ["Root", "A"],
  "operation": "replace",
  "scope": "parent",
  "destination": {"parent": ["Root", "B"], "place": "last"},
  "ifMatch": "<current version>"
}
```

After a structural patch, check `vault_get_document_map` for actual nesting or
read the whole file with `vault_read({"path":"note.md"})` for stored `#` levels.
Targeted heading reads normalize levels relative to the selected scope, so
their displayed `#` counts alone cannot confirm the stored hierarchy.
<!-- /obsidian-help -->

<!-- obsidian-help:write -->
### Writing and appending text

`vault_write` creates a UTF-8 text file or replaces its whole content.
`vault_append` adds text, creating the file if missing. Both create missing
parent directories. Binary file extensions, NUL and malformed text are refused.

For an existing file, obtain its latest `version` with `vault_read` or
`vault_get_document_map` and pass it as `ifMatch`; there is no force bypass.
For a new file omit `ifMatch`. A version conflict means the file changed:
reread, reconcile the intended edit, then decide whether to submit a new write.
No mutation is automatically retried on conflict or failure.

Append adds LF before the supplied text when an existing file does not end in
LF, including an empty existing file. A missing file receives exactly the
supplied content. Successful writes return a compact receipt with the new
version, not the whole note. A successful receipt with a cleanup warning means
the content was saved; inspect the warning instead of blindly appending again.
<!-- /obsidian-help -->

<!-- obsidian-help:paths -->
## Paths and file limits

One shared sandbox rejects absolute/traversing/noncanonical paths, symbolic
links, escape, reserved Windows names and replacement of the original Vault
root. Dot-prefixed components are protected internals; embedders can protect
additional internal-state subtrees. Discovery and direct tools use the same
policy. These are generic containment and internal-state safeguards.
Text access rejects binary extensions, NUL and malformed UTF-8/Unicode, while
preserving BOM and original newlines. Reads and mutations default to 4 MiB with
a 64 MiB hard cap.
<!-- /obsidian-help -->

The mutation path is deliberately small:

1. Serialize the relative path across store instances in this process; safely
   read existing bytes and require exact-byte `ifMatch` for existing write/append
   and all patches. Validate the prepared text before changing files.
2. Create missing parent directories through the shared sandbox. Write a hidden
   `.obsidian-mcp-<random>.tmp` beside the target using exclusive creation.
   Normal OS creation defaults inherit directory permissions/default ACLs;
   MCP never calls chown/chmod/setfacl or runs a permissions hook.
3. Flush the completed temporary file, close it, and revalidate parents, path,
   temporary identity and the original exact-byte version. No append/patch retry.
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
Write/append/patch success is a compact `message: "OK"` receipt with path,
exact-byte version, byte count, creation status and any warnings, without echoing
the note body.

<!-- obsidian-help:files -->
## Moving and deleting files

`vault_move` takes `path`, `destination` and optional `allowOverwrite` (false by
default), returning `{message: "OK", oldPath, newPath}`. Missing destination
parents are created. A trailing `/` retains the filename; an empty destination
moves to the Vault root. Desktop link rewriting and history updates are
unavailable, so referring notes are unchanged. Overwrites use atomic rename.
Without overwrite permission, atomic hard-link publication refuses a raced-in
destination, followed by source unlink. Both names briefly exist; a failed source
unlink removes only the newly created link. If safe cleanup fails, the error
names both relative paths for inspection. There is no copy fallback or retry.

`vault_delete` takes `path` and optional `permanent` (false by default).
Recoverable deletion renames into `.trash/<unique-directory>/<filename>` on the
same filesystem and returns `message`, `path`, `permanent: false` and `trashPath`.
Recovery uses filesystem access to that receipt path; `.trash` is protected from
ordinary MCP tools. `permanent: true` unlinks the file and returns `message`,
`path` and `permanent: true`. Trash failure never falls back to permanent deletion.

Both tools accept an optional SHA-256 `ifMatch` extension and share the mutation
locks and path checks. They can relocate/delete attachments without decoding or
transferring their bytes. Version checking is limited to 64 MiB; omitted tokens
retain Local REST's operation-on-current-path behavior. Operations on directories
and additional hard links are refused; directory deletion could contain protected
internal descendants. The exact Desktop differences are recorded in the parity table.
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
