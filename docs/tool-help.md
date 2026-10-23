# Tool reference

These marked sections are the canonical detailed tool manuals bundled by
`obsidian_help`. Examples are independent requests, not a sequence to replay.
Replace `<current version>` with the exact `sha256:` token from the indicated
current read or document map; the placeholder itself is not a valid token.
All paths are Vault-relative and use `/`. Related help names below are `topic`
values for `obsidian_help`.

<!-- obsidian-help:obsidian_help -->
## obsidian_help — Discover guides and tool manuals

Read static usage documentation without reading a Vault, contacting a network
service or changing files. Use MCP tool discovery to learn what this endpoint
can execute; this manual does not grant access or enable an omitted tool.

The only optional argument is `topic`. Omit it for the compact **Guides** and
**Tools** index. The Tools group lists the names actually registered on this
endpoint. Supply an exact guide or tool name to receive that one topic alone,
including its purpose, contract, examples and related help.

The four reading/navigation aliases `vault_list_text`, `vault_read_text`,
`vault_get_document_map_text` and `search_query_text` are also valid tool-topic
names. Each shares the corresponding canonical tool's inputs and semantics;
the endpoint selects its available tool names and result presentation. A
manual can exist even when that tool is unavailable on the current endpoint.
In that case, its manual starts with an availability notice and names a
registered counterpart when one exists; the notice does not change capability.

The result's `text` is the requested manual or index. An unknown topic returns
`obsidian_help.unknown_topic` with the recovery index; choose a name from it
instead of guessing another spelling.

Discover the index:

```json
{}
```

Read the search tool manual directly:

```json
{"topic":"search_query"}
```

Related: the Guides index provides workflow overviews; the Tools index and MCP
tool discovery provide exact names for this endpoint.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_list -->
## vault_list — List one Vault directory

Discover filenames and immediate subdirectories before choosing a read or
mutation target. This lists one directory, without recursion or a search query.
Use `search_query` to scan Markdown content and properties.

`path` is optional: omit it or pass `""` for the Vault root. `/` and `.` are not
root aliases. A directory path may have one trailing `/`. `maxEntries` is an
optional integer from 1 to 10,000, default 1,000. It counts filesystem entries
encountered, including entries later omitted from the result.

The result's `files` is the complete sorted array of child names, relative to
the listed directory. Directory names end in `/`; real empty directories are
included. Prepend the directory path when using a child with another tool.
Protected internal paths, symlinks and special filesystem entries are omitted.
Discovery does not follow symlinks or override filesystem permissions.

`vault_list.too_many_entries` fails the request instead of truncating or paging.
If intentional, increase `maxEntries` within its hard limit; otherwise choose a
known narrower directory. For `not_found` or `not_directory`, correct the path
using its parent's listing. A `changed_during_list` error means the listing
could not establish a stable result; inspect current paths before another call.

List the root:

```json
{}
```

Independently, list an existing `projects/` directory:

```json
{"path":"projects/","maxEntries":2000}
```

Related guides: `read`, `paths`. Related tools: `vault_read`, `search_query`,
`vault_get_document_map`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_read -->
## vault_read — Read text or a structured target

Read a complete UTF-8 text file with metadata, or select one heading, referenced
block or frontmatter property. Use `vault_get_document_map` to discover
structural addresses without returning the whole body; use `vault_read_binary`
for supported attachments.

`path` is required. Omit `targetType`, `target` and `scope` for a whole-file
read. The result contains canonical `path`, unchanged `content`, direct `tags`
without `#` or added parent tags, parsed `frontmatter`, filesystem `stat`, and
the exact-byte SHA-256 `version`. `stat.ctime` and `stat.mtime` are milliseconds;
`stat.size` is bytes. Creation time can be zero when unavailable. These
timestamps are informational; use `version` as a mutation's `ifMatch`.

For a targeted read, supply `targetType` and `target` together. Heading targets
are arrays containing the full ancestor path from the top level. Copy every key
unchanged from the map, including duplicate-heading disambiguators. A
JSON-encoded path-array string is accepted for clients that stringify this
argument; a bare heading label is rejected. Block targets are bare IDs without
`^`; frontmatter targets are property names. Optional `scope` requires a target
and defaults to `content`:

| Target | `content` | `marker` | `markerAndContent` |
| --- | --- | --- | --- |
| Heading | Body and descendants, with heading levels relative to the target | Heading label | Whole subtree, with levels relative to the parent |
| Block | Block text | Bare block ID | Text plus its ID span |
| Frontmatter | Typed JSON value | Property name | One-property JSON object |

Targeted results contain `path`, the full source's `version`, and `result`:
Markdown text for heading/block reads, or the selected typed frontmatter value.
Targeted heading levels are relative; their displayed `#` counts do not prove
stored hierarchy. For exact literal replacement, copy an unchanged slice from
a whole-file read's `content` and the version from that same response.

`maxBytes` limits the **entire source file**, including for a small target. It
defaults to 4 MiB and accepts integers from 0 through 64 MiB (67,108,864 bytes).
For `vault_read.too_large`, numeric `error.details.observedSizeBytes` can be
reused as `maxBytes` when it is within that hard cap. Larger files cannot be
recovered by raising the limit. Above `Number.MAX_SAFE_INTEGER`, the numeric
field is absent and `observedSizeBytesExact` gives a decimal string; it is not
a valid numeric input. No input coercion is applied.

All reads enforce protected-path, symlink, text-extension, NUL and strict UTF-8
checks. Original BOM and newlines are retained. Whole-file reads still parse
frontmatter; malformed or unsupported YAML fails explicitly. A heading
`vault_semantic.TargetNotFoundError` calls for checking the full exact map path,
not dropping ancestor names. There is no Desktop link graph in this result.

Read an existing `note.md`:

```json
{"path":"note.md"}
```

Independently, for `## A` inside `# Root`, read its body:

```json
{"path":"note.md","targetType":"heading","target":["Root","A"]}
```

Independently, for an existing `status` property, read its typed value:

```json
{"path":"note.md","targetType":"frontmatter","target":"status"}
```

Related guides: `read`, `paths`. Related tools: `vault_get_document_map`,
`vault_replace_text`, `vault_patch`, `reference_query`, `vault_read_binary`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_get_document_map -->
## vault_get_document_map — Discover structural addresses

Read a text document's address map before a targeted read or patch. This finds
heading paths, block IDs and frontmatter keys without returning the note body.
Use `vault_read` when the text itself or an exact source slice is needed.

`path` is required. Optional `maxBytes` limits the entire source, default
4 MiB and hard maximum 64 MiB; it does not limit the size of a selected section.
Optional `maxHeadings` is an integer from 1 through 100,000, default 10,000.

The result contains `path`, exact-byte `version`, a nested `headings` tree,
ordered `blocks` IDs and `frontmatterFields`. It includes the parser's duplicate
heading disambiguators and setext headings. Copy keys unchanged along the full
ancestor path; do not reconstruct an address from visible heading labels.
Use this version as `ifMatch` only for an edit based on this observed document.
Map addresses are tool addresses, not link-fragment spelling for
`reference_query`.

`vault_document_map.too_many_headings` returns no partial map. Raise
`maxHeadings` intentionally within the hard cap, or use a whole-file read when
appropriate. `vault_read.too_large` uses the shared read error details: a
numeric `observedSizeBytes` within 67,108,864 can be supplied as `maxBytes`;
larger sources are unsupported. Protected paths, symlinks, invalid text and
malformed or unsupported frontmatter also fail explicitly. After a structural
patch, inspect a fresh map for actual nesting or read the whole file for stored
heading levels.

For an existing `note.md`:

```json
{"path":"note.md"}
```

Related guides: `read`, `patch`, `paths`. Related tools: `vault_read`,
`vault_patch`, `reference_query`.
<!-- /obsidian-help -->

<!-- obsidian-help:search_query -->
## search_query — Evaluate JsonLogic over Markdown notes

Search Markdown content and metadata with a JsonLogic `query`. Use `vault_list`
for filenames in one directory, `tag_list` for aggregated tags, and
`reference_query` for supported link resolution. Searching literal link text
does not establish a backlink or resolve another spelling of that link.

`query` is a JSON object. An operator expression has exactly one key;
multi-key objects are literal data. For example, `{"a":1,"b":2}` returns that
truthy object for every scanned note instead of applying two conditions.
Combine conditions with `and` or `or`.

Use JsonLogic `var` with these fields:

| Field | Meaning |
| --- | --- |
| `path` | Canonical Vault-relative filename |
| `content` | Complete Markdown source, including frontmatter |
| `tags` | Direct frontmatter and inline tags, without `#` or added parents |
| `frontmatter` | Parsed JSON properties; dot notation such as `frontmatter.foo` selects a property |
| `stat` | `ctime` and `mtime` in milliseconds, `size` in bytes |

JsonLogic supports comparisons, coercion, missing/default values, logic,
arithmetic, strings and collection operators, plus `glob` and bounded `regexp`.
These extensions take a pattern then the field value. Glob matching is
case-sensitive; `*` crosses `/` and `?` is literal. Unsafe prototype access and
`log` are rejected. Root fields `links`, `backlinks` and `unresolvedLinks` are
unavailable; there is no inferred Desktop graph.

Optional `scope` has required `directory` and `recursive` fields. Directory
`""` is root; false scans only direct child Markdown files, true includes
subdirectories. Omit scope for a recursive whole-Vault scan. **Only scope
prunes the scan.** A query condition on `path` or a glob filters results after
reading and parsing candidate notes.

Optional budget inputs normally can be omitted:

| Input | Default | Hard maximum |
| --- | --- | --- |
| `maxEntries` | 20,000 | 200,000 |
| `maxFiles` | 5,000 Markdown files | 50,000 |
| `maxFileBytes` | 4 MiB | 64 MiB |
| `maxTotalBytes` | 64 MiB | 1 GiB |
| `maxResults` | 500 | 10,000 |

Counts are positive integers; the two byte inputs also accept zero.
`maxTotalBytes` limits scanned source bytes, not response size. Result values
and aggregate accounting have a fixed 4 MiB output budget including
conservative per-result overhead; `maxOutputBytes` is **not** an input.
Queries also have input/structure and worker limits: 16 KiB serialized query,
64 operator nodes, eight operator levels and 1,024 UTF-16 units per evaluated
literal string, with bounded evaluation time and concurrency.

The result's `results` contains `filename`, the evaluated source's exact-byte
`version`, and the query's truthy `result`. The result is not automatically a
snippet or Boolean. Null, false, zero, empty strings, empty arrays and empty
objects are omitted. Each version describes its source observation; the scan
is not an atomic whole-Vault snapshot.

Overflow fails explicitly without partial results. For
`search_query.budget_exceeded`, inspect `error.details.budget`: narrow `scope`,
return a smaller value, or intentionally raise that configurable budget within
its maximum. For `maxOutputBytes`, reduce returned values or matches. Correct
invalid expressions using `search_query.invalid_query`'s reason. Malformed or
unsupported frontmatter in any scanned note fails the scan; a query path
condition does not bypass it. Reconcile traversal/source changes before a new
call; no automatic retries occur.

Find notes containing the case-sensitive literal `needle`:

```json
{"query":{"in":["needle",{"var":"content"}]}}
```

Independently, find notes whose frontmatter has `foo: bar`:

```json
{"query":{"===":[{"var":"frontmatter.foo"},"bar"]}}
```

Independently, assuming `projects/` exists, scan it recursively for both
conditions, with a 50-match cap that fails on overflow:

```json
{
  "scope":{"directory":"projects","recursive":true},
  "query":{"and":[
    {"in":["needle",{"var":"content"}]},
    {"===":[{"var":"frontmatter.foo"},"bar"]}
  ]},
  "maxResults":50
}
```

Related guides: `search`, `read`, `references`, `paths`. Related tools:
`vault_read`, `vault_get_document_map`, `tag_list`, `reference_query`.
<!-- /obsidian-help -->

<!-- obsidian-help:tag_list -->
## tag_list — Count tags and nested parents

Scan Markdown files recursively across the Vault and return tags with per-file
counts. Use `search_query` for filtering individual notes or `vault_read` for
one note's direct tags.

All arguments are optional budget integers. `maxEntries` defaults to 20,000
(maximum 200,000), `maxFiles` to 5,000 (50,000), `maxFileBytes` to 4 MiB
(64 MiB), `maxTotalBytes` to 64 MiB (1 GiB), and `maxTags` to 5,000 (50,000).
Counts must be positive; byte inputs can be zero. There is no `scope` or query
argument. `maxTags` includes generated parent names, and `maxTotalBytes`
counts scanned bytes.

The result's `tags` entries contain `name` without `#` and positive `count`.
A file contributes at most one count to a tag, regardless of repetitions.
Nested tags add parents: a file containing `a/b` also contributes to `a`.
Case variants are folded for counting and sorting, retaining the first
deterministic source spelling. `vault_read` and `search_query` instead expose
direct tags without adding parents.

Tags come from string entries in the frontmatter `tags` list and conservative
inline hashtag recognition, which can differ from Obsidian Desktop. Protected
paths and symlinks are not traversed. Malformed or unsupported frontmatter in
any scanned note fails explicitly.

`tag_list.budget_exceeded` returns no truncated list; inspect
`error.details.budget` and deliberately raise that budget within its maximum
if appropriate. For a narrower scoped investigation use `search_query`.
For source/traversal failures, inspect the reported path and current state
before another call; repeated calls do not repair a malformed note.

List tags with default limits:

```json
{}
```

Related guides: `tags`, `search`, `paths`. Related tools: `search_query`,
`vault_read`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_read_binary -->
## vault_read_binary — Preview or deliver non-PDF attachments

Read an image preview, obtain a protected download link, or explicitly transfer
original attachment bytes. This is read-only and performs no OCR, document
extraction, upload or Vault mutation. Use `vault_read` for text.

Required `path` follows the same Vault-relative path, symlink and filesystem
permission boundaries as other reads. MIME type is inferred from the filename,
falling back to `application/octet-stream`. Optional `as` is `auto` (default),
`bytes` or `link`:

- `auto` previews PNG/JPEG/GIF/WebP as WebP. The first frame is auto-oriented
  and resized without enlargement to at most 1568 pixels per edge. Preview
  output is at most 1 MiB, input at most 40 million pixels and 64 MiB, with a
  five-second conversion limit. The original is unchanged.
- `auto` for every other non-PDF file returns a signed HTTPS link, including
  small/empty files and SVG. An oversized or unavailable raster preview also
  selects a link. The client must fetch it to obtain the original bytes.
- `link` requests the original file's download link directly.
- `bytes` returns unchanged original bytes as a binary resource, with an
  inclusive 4 MiB hard cap. It never converts, truncates or silently falls
  back to a link.

Metadata identifies `delivery` (`image`, `bytes` or `link`), `path`, source
`mimeType` and `sizeBytes`. Image metadata also identifies the preview's type,
size, dimensions and whether it contains only the first frame. Inline image
and byte results carry the source's exact-byte `version`. A byte resource's
`obsidian-vault://attachment/…` URI can be read again through MCP resources
with the same 4 MiB cap and version check; it is not a browser URL.

Link metadata includes HTTPS `uri`, `expiresAt` within 15 minutes and a reason.
Links require a deployment-provided download handler that enforces path
protection, caller identity, current read permissions and the PDF exclusion at
download time, and delivers original bytes without a login page. Non-preview
`auto` and explicit `link` inspect without loading/hashing the body and claim
no content version; they refer to the file at download time. A preview fallback
that carries a version must deliver those exact bytes or refuse a change.

PDF is intentionally rejected in every mode and through resource reads with
`vault_read_binary.unsupported_pdf`. Use the client's native file upload or
attachment feature; changing `as` cannot enable PDFs. Stock stdio has no link
provider: generic downloads, explicit links and preview fallbacks return
`vault_read_binary.link_unavailable`. Explicit bytes can be chosen for a
supported non-PDF file within 4 MiB when its original bytes are useful. A
`too_large` byte error cannot be fixed by raising a tool argument; choose an
available link instead. A version-conflicted resource requires a fresh tool
read. There are no automatic retries.

Assuming an existing supported image, request its preview:

```json
{"path":"Attachments/diagram.png"}
```

Independently, for an existing non-PDF archive no larger than 4 MiB:

```json
{"path":"Attachments/archive.zip","as":"bytes"}
```

Independently, when a deployment link provider is configured:

```json
{"path":"Attachments/recording.mp4","as":"link"}
```

Related guides: `binary`, `paths`. Related tools: `vault_list`, `vault_read`,
`reference_query`.
<!-- /obsidian-help -->

<!-- obsidian-help:reference_query -->
## reference_query — Find bounded references to a file or anchor

Find supported internal references to one exact file, heading or block without
modifying files or maintaining a link database. Use `search_query` for literal
content candidates; use this tool when resolution and uncertainty matter.
It does not repair links or recreate Obsidian Desktop's private resolver.

Required `scope: {directory, recursive}` selects Markdown source bodies to
read; `directory: ""` is root and recursion is explicit. Required `target`
contains a Vault-relative file `path` including its extension, and optionally
either `heading` or `block`, never both. A heading is an array of exact,
case-sensitive plain labels in consecutive ancestry order. Duplicate anchors
remain ambiguous; document-map duplicate suffixes are not link fragments.
A block is its bare Latin-letter/digit/hyphen ID without `^`.

Optional `resolutionScope` has the same shape as `scope` and defaults to it.
It inventories filenames, including attachments, rather than reading every
body. A recursive root inventory establishes uniqueness of a bare wikilink
such as `[[Design]]` among accessible files. One candidate in a partial
inventory remains `unknown`; multiple candidates are `ambiguous`. Explicit
paths to the target can resolve outside that inventory. The explicit target
is inspected/read even outside the source and resolution scopes.

The result separates confirmed `matches` from `uncertain` occurrences across
the source scope. Uncertainties can be unrelated to the requested target and
must not be presented as inferred backlinks. Each occurrence gives source
path and exact-byte version, `raw`, parsed `href`, syntax, embed flag,
status/reason and known destination or candidates. `start`/`end` are zero-based,
half-open UTF-16 indices into exact source text; `line` and UTF-16 `column` are
one-based. These are not byte offsets or rendered-text coordinates.

`target.fileExists` describes the file, while `target.status` describes the
requested file/anchor. Missing targets can be queried to inspect dangling
references. Markdown target inspection provides its exact-byte version.
`coverage.complete` describes only the bounded supported operation;
`incomingOutsideScope` stays `unknown` and `atomicSnapshot` stays false.

Supported forms include ordinary wikilinks, CommonMark inline/reference links,
display aliases and embeds. Frontmatter aliases do not create filename
candidates. Frontmatter, code, comments, balanced math, HTML and external URLs
are excluded. Formatted heading anchors and unsupported fragments are reported
conservatively. Attachments are checked for existence only; page/time fragments
and PDF extraction are unsupported.

Optional positive integer limits have these defaults/hard maxima:
`maxEntries` 20,000/200,000; `maxFiles` 2,000/10,000 inventoried files;
`maxFileBytes` 1/4 MiB; `maxTotalBytes` 8/32 MiB; `maxResults` 1,000/10,000
combined matches and uncertainties; `maxOutputBytes` 1/4 MiB. Source reads and
the target's final recheck share the total-byte budget. Parsing also has worker,
time and structural limits.

Budget, scan, parse and detected namespace/target-change failures return no
successful partial arrays. On `reference_query.budget_exceeded`, narrow the
declared scopes or intentionally raise the relevant limit within its maximum.
A wider inventory can resolve `unknown` bare filenames; ambiguous names need
explicit paths or inspection, not first-candidate selection. Inspect current
state after `changed_during_query`. No mutation, repair or automatic retry
is performed.

Assuming `projects/` exists, find references there to `note.md`, using a whole
accessible-Vault filename inventory:

```json
{
  "scope":{"directory":"projects","recursive":true},
  "resolutionScope":{"directory":"","recursive":true},
  "target":{"path":"note.md"}
}
```

Independently, for `## A` inside `# Root` in `note.md`:

```json
{
  "scope":{"directory":"","recursive":true},
  "target":{"path":"note.md","heading":["Root","A"]}
}
```

Independently, for block `^decision` in `note.md`:

```json
{
  "scope":{"directory":"","recursive":true},
  "target":{"path":"note.md","block":"decision"}
}
```

Related guides: `references`, `search`, `paths`. Related tools: `vault_read`,
`vault_get_document_map`, `search_query`, `vault_move`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_write -->
## vault_write — Create or replace a whole text file

Save supplied UTF-8 text as a new file or replace an existing file's complete
content. Use `vault_append` for additions, `vault_replace_text` for one unique
literal edit, and `vault_patch` for structural editing.

Required arguments are `path` and `content`. For a new file, omit `ifMatch`;
for an existing file, provide its latest exact-byte `version` from a read or
map as `ifMatch`. An existing file without that token is refused, and a token
for a missing file conflicts. There is no force bypass. Missing parent
directories are created through the shared path checks.

Known binary extensions, NUL and malformed UTF-8/Unicode are refused. The
store's configured text limit applies to the old and saved file: 4 MiB by
default, 64 MiB hard maximum. This tool does not expose a `maxBytes` argument.
The supplied text is literal; it does not validate Markdown structure or
normalize BOM, line endings or Unicode. Existing paths must use their exact
case/Unicode spelling; protected internals, symlinks and extra hard links are
refused.

Saving uses version checks and atomic publication. The receipt contains
`message: "OK"`, `path`, new exact-byte `version`, `beforeSizeBytes`,
`sizeBytes` and `created`, plus optional warnings. Byte counts measure old and
saved UTF-8 content. Missing and empty originals both have `beforeSizeBytes: 0`;
`created` distinguishes them. The receipt contains no body or diff and does not
confirm intended structure.

On `vault_mutation.version_conflict`, reread, reconcile the intended edit and
decide whether to submit a new request. `if_match_required` needs a current
token, not another unversioned call. A successful
`temporary_cleanup_failed` warning means the content was saved and a protected
temporary name remains; inspect it through filesystem maintenance instead of
blindly writing again. No mutation is automatically retried.

For a missing `note.md`, create it:

```json
{"path":"note.md","content":"# Root\n\nNew body.\n"}
```

Independently, replace an existing `note.md` after reading its current version:

```json
{"path":"note.md","content":"# Root\n\nReplacement body.\n","ifMatch":"<current version>"}
```

Related guides: `write`, `paths`. Related tools: `vault_read`,
`vault_get_document_map`, `vault_append`, `vault_replace_text`, `vault_patch`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_append -->
## vault_append — Add literal text at the end of a file

Append supplied UTF-8 text, creating a missing file and parent directories.
Use `vault_patch` to add within a selected section, `vault_replace_text` for
one unique literal edit, or `vault_write` for complete replacement.

Required `path` and `content` use the same text/path safeguards as writing.
Existing files require `ifMatch` from a current read or map; omit it for a new
file. No force bypass exists. Protected paths, symlinks, extra hard links,
binary extensions, NUL and malformed text are refused.

If an existing file lacks a final LF, append adds one before the supplied
content, **including when the existing file is empty**. If it already ends in
LF, no separator is added. A missing file receives exactly the supplied text.
Beyond that separator, text is preserved literally, with no Markdown nesting
validation. For literal stored heading levels at file end, this tool avoids
the relative-level semantics of a structural patch.

The store's configured old/result text limit is 4 MiB by default and at most
64 MiB; there is no request `maxBytes`. The atomic save receipt contains
`message: "OK"`, `path`, new exact-byte `version`, `beforeSizeBytes`,
`sizeBytes`, `created` and optional warnings. Sizes are UTF-8 bytes; `created`
distinguishes a missing original from an empty one. It returns no body or diff.

On `vault_mutation.version_conflict`, reread and reconcile before deciding on
a new append. A successful `temporary_cleanup_failed` warning still means the
append was saved; inspect the saved content and warning instead of appending
again. There is no automatic retry, and replaying an append can duplicate text.

For an existing `note.md`, use its current version:

```json
{"path":"note.md","content":"Added paragraph.\n","ifMatch":"<current version>"}
```

Independently, for a missing file, create it with exactly this content:

```json
{"path":"note.md","content":"# Root\n\nFirst entry.\n"}
```

Related guides: `write`, `patch`, `paths`. Related tools: `vault_read`,
`vault_get_document_map`, `vault_write`, `vault_patch`, `vault_replace_text`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_replace_text -->
## vault_replace_text — Replace one unique literal source slice

Edit one exact substring in an existing UTF-8 text file. Use this for an inline
or source-sensitive edit; use `vault_patch` for a known heading/block/property,
`vault_append` for a file-end addition, or `vault_write` for a complete rewrite.

Exactly four fields are required: `path`, nonempty `oldText`, `newText` and
`ifMatch`. First read the **whole file** with `vault_read`, copy an unchanged
slice from its `content`, and use that same response's exact-byte `version` as
`ifMatch`. Targeted heading reads normalize levels and may not provide an exact
source slice.

Matching is literal, case-sensitive and over the entire file. `oldText` must
occur exactly once, **counting overlapping occurrences**. An empty `newText`
deletes the unique match; equal strings fail with `vault_mutation.no_change`.
Replacement text is literal too: `$&` and `$1` have no substitution meaning.
No newline, BOM or Unicode normalization is applied; unmatched bytes remain
unchanged. There are no scope, occurrence-index, replace-all, regex, fuzzy or
batch options.

The two input strings together may contain at most 4 MiB of UTF-8 bytes. The
old and resulting file also obey the store's configured text limit, default
4 MiB and hard maximum 64 MiB. The shared path/text policy and atomic save
apply; protected paths, symlinks, extra hard links, binary extensions, NUL and
malformed text are refused. Replacement does not run the Markdown parser,
but the recommended whole-file read still parses frontmatter and can reject
malformed or unsupported YAML; this is not a malformed-YAML recovery workflow.

`vault_mutation.text_not_found` gives `matchCount: 0`;
`vault_mutation.ambiguous_text` gives `matchCountAtLeast: 2`. Neither exposes
offsets or snippets. Reread and expand `oldText` with surrounding original text
until the intended location is unique. On a version conflict, reconcile with
the current whole-file text. Nothing is written for these match failures, and
no mutation is automatically retried.

Success returns the compact write receipt (`message`, `path`, new `version`,
`beforeSizeBytes`, `sizeBytes`, `created`, optional warnings) plus
`replacementCount: 1`. Sizes are UTF-8 bytes; `created` is false. A successful
cleanup warning still means the edit was saved. The receipt does not contain
the new body or verify Markdown structure; inspect content when that matters.

Assume a whole-file read of `note.md` contains `Old body.` exactly once. Copy
that text and the version from the same response:

```json
{
  "path":"note.md",
  "oldText":"Old body.",
  "newText":"New body. $& is literal.",
  "ifMatch":"<current version>"
}
```

Related guides: `write`, `read`, `paths`. Related tools: `vault_read`,
`vault_patch`, `vault_append`, `vault_write`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_patch -->
## vault_patch — Edit one heading, block or frontmatter property

Apply one structural instruction to an existing text file. Obtain exact target
addresses and the current full-file version with `vault_get_document_map`;
read the relevant text when the edit requires it. Use `vault_replace_text` for
one unique literal source slice, or `vault_append` for literal file-end text.

Required fields are `path`, `targetType`, `target`, `operation` and exact-byte
`ifMatch`. `targetType` is `heading`, `block` or `frontmatter`. A heading target
is its full path-array from the map, including duplicate disambiguators;
`null` or `[]` selects the document root. A JSON-encoded array string is also
accepted for clients that stringify it. A block target is a bare ID without
`^`; a frontmatter target is a property name.

`operation` is `replace`, `prepend`, `append` or `delete`. `scope` defaults to
`content`. Supply exactly one appropriate payload: `content` for Markdown or
labels, `value` for typed JSON properties or structured table rows, or
`destination` for a heading move. `delete` has no payload. Unknown fields,
multiple payloads and invalid operation/scope combinations fail explicitly.

For headings, `content` edits everything below the heading line, including
descendants; `marker` replaces the label using plain text without `#` or
deletes only the heading line; `markerAndContent` includes the heading and
its subtree. With the latter scope, prepend/append insert before/after the
selected section and its descendants. `parent` is valid only for a heading
`replace` carrying `destination`.

Without `within`, heading levels in `content` are relative:

| Scope and operation | Meaning of input starting with `#` |
| --- | --- |
| `content`, replace/prepend/append | One level below the selected heading |
| `markerAndContent`, prepend/append | One level below the target's actual parent; stored depth is that parent's physical level plus input depth |
| `markerAndContent`, replace | Whole replacement section rebased to its parent |

For consecutive levels, a `markerAndContent` insertion can be a sibling.
Skipped heading levels can change existing nesting, so sibling placement is
not guaranteed. A whole-section replacement without a heading can dissolve
the heading. The engine owns section-edge blank-line separation; use a literal
replacement when exact source whitespace is required. Depth beyond six is
saved with a `heading-depth-overflow` warning.

Optional `within` refines a heading to one direct body block: zero-based in
document order, with negative indices from the end. It does not index child
headings or isolated block-ID marker lines. With default `content` scope,
replace/prepend/append splice literally into that block; the caller supplies
needed separators. With `markerAndContent`, prepend/append insert a new block
beside it. Use a block-ID target when available. A literal append after an inline
ID can unmark it; deleting an indexed block can leave an isolated ID dangling.
Pair positional choices with the version observed while selecting the block.

A heading content/whole-section `replace` without `within` fails with
`vault_semantic.subtree_confirmation_required` when child headings would be
removed. Set `allowSubtreeReplacement: true` only when replacing that whole
subtree is intended, still using a fresh `ifMatch`. To change one direct body
block while retaining children, use the appropriate `within` index, such as
`within: 0`. The confirmation flag is invalid for other edit types.

For frontmatter, use `value` to preserve JSON types. Content replace sets the
value; prepend/append concatenate lists/strings or merge objects in the
requested order. Content delete retains the key with null; `markerAndContent`
delete removes the property. Marker replace uses `content` to rename the key.
`markerAndContent` prepend/append takes a `value` object of new properties;
collisions fail. `createTargetIfMissing: true` permits creation only where the
operation supports it; missing targets are not created implicitly.
`rejectIfContentPreexists` applies to text insertion, not property
deduplication. Property edits preserve unrelated property text/comments, body,
BOM and line endings. Malformed/unsupported YAML, top-level flow mappings and
prototype-named property edits are refused.

A table addressed by block ID supports typed row edits through `value` as
arrays of cell-string arrays for replace/prepend/append. Headers remain;
column counts must match, embedded newlines are refused and cell pipes are
escaped. A `within`-addressed table takes literal text edits instead.

A heading move uses `operation: "replace"`, `scope: "parent"`, no content,
and `destination: {parent, place}`. Parent is a heading path or `null` for
document root. Place is `first`, `last`, or an object selecting `before` or
`after` an exact sibling heading path. The moved subtree is re-levelled.

Serialized patch input is capped at 4 MiB; old/result text obeys the store's
configured text limit (4 MiB default, 64 MiB maximum). The common path/text
safeguards and atomic save apply. Success is a compact receipt containing
`message: "OK"`, `path`, new `version`, `beforeSizeBytes`, `sizeBytes`,
`created: false` and optional warnings, without the body or diff.

On a missing heading or body block, check the full exact map path and any
`within` index. On `vault_semantic.invalid_instruction`, correct the
scope/payload pairing; on a version conflict, reread and reconcile. No
automatic retries occur. A successful temporary-cleanup warning means saved
content remains saved. After a structural patch, inspect a fresh map for
actual nesting or a whole-file read for stored `#` levels; targeted heading
reads alone cannot confirm those levels.

These three examples are independent. For the first and third, assume
`note.md` has `# Root` containing consecutive `## A` and `## B` sections.
Use a current map/read version for each example.

Insert `## Inserted` immediately after A and its descendants, before B:

```json
{
  "path":"note.md",
  "targetType":"heading",
  "target":["Root","A"],
  "operation":"append",
  "scope":"markerAndContent",
  "content":"# Inserted",
  "ifMatch":"<current version>"
}
```

Independently, set typed property `status` to the string `ready`, creating the
property/frontmatter if missing:

```json
{
  "path":"note.md",
  "targetType":"frontmatter",
  "target":"status",
  "operation":"replace",
  "value":"ready",
  "createTargetIfMissing":true,
  "ifMatch":"<current version>"
}
```

Independently, move A under B as B's last child:

```json
{
  "path":"note.md",
  "targetType":"heading",
  "target":["Root","A"],
  "operation":"replace",
  "scope":"parent",
  "destination":{"parent":["Root","B"],"place":"last"},
  "ifMatch":"<current version>"
}
```

Related guides: `patch`, `write`, `read`, `paths`. Related tools:
`vault_get_document_map`, `vault_read`, `vault_replace_text`, `vault_append`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_move -->
## vault_move — Move or rename one file

Move a regular file, including an attachment, without decoding or transferring
its bytes. This does not update referring notes or Desktop link/history state.
Use `reference_query` to inspect supported references and `vault_patch` to
move a heading inside one note.

Required `path` names the source. Required `destination` is either a new
Vault-relative filename, a directory ending in `/` to retain the basename,
or `""` to move the file to the Vault root. Missing destination parents are
created. Optional `allowOverwrite` defaults to false; an existing destination
fails unless true. With overwrite enabled, replacement uses atomic rename.

Optional `ifMatch` checks **only the source's** exact bytes and is limited to
64 MiB; it does not version-check overwritten destination content. Without a
token the tool operates on the current path, without reading/hashing the body
or imposing that byte cap. Identical normalized source/destination is a no-op,
even for a missing file, but a supplied token still requires a matching file.

Both paths enforce protected-internal, traversal, symlink, exact name-spelling
and additional-hard-link safeguards. Directories are refused. Without
overwrite, publication refuses a raced-in destination, then removes the source;
both names can briefly exist. This requires one filesystem; there is no copy
fallback or automatic retry. Success returns `message: "OK"`, `oldPath` and
`newPath`, without a new content version.

On `vault_mutation.destination_exists`, inspect the destination and choose
another path or explicitly decide on overwrite. On `version_conflict`, inspect
the current source before a new request. On `source_cleanup_failed`, inspect
both paths named in the error before proceeding; the move did not finish its
safe cleanup. `cross_device` requires a different external transfer workflow.
No failure triggers automatic retry or link repair.

For an existing `note.md`, rename/move it using a current source version:

```json
{"path":"note.md","destination":"Archive/renamed.md","ifMatch":"<current version>"}
```

Independently, move an existing attachment into `Archive/`, keeping its name:

```json
{"path":"Attachments/diagram.png","destination":"Archive/"}
```

Related guides: `files`, `paths`, `references`. Related tools: `vault_list`,
`vault_read`, `reference_query`, `vault_delete`, `vault_patch`.
<!-- /obsidian-help -->

<!-- obsidian-help:vault_delete -->
## vault_delete — Trash or permanently delete one file

Remove a regular file, including an attachment, without decoding its content.
Default deletion is recoverable Vault-local trash; `permanent: true` unlinks
the file irreversibly. This does not rewrite references or use Desktop trash
preferences. Use `reference_query` to inspect supported incoming references
and `vault_move` when relocation is intended.

`path` is required. Optional `permanent` defaults to false. Recoverable deletion
renames into `.trash/<unique-directory>/<filename>` on the same filesystem.
Success returns `message: "OK"`, `path`, `permanent: false` and `trashPath`.
Keep that receipt for recovery through filesystem access: `.trash` is protected
from ordinary MCP listing, reading and mutations. Permanent deletion instead
returns `message`, `path` and `permanent: true`, without a recovery path.

Optional `ifMatch` checks the source's exact bytes with a 64 MiB maximum.
Omitting it operates on the current path without hashing/reading its body or
that size cap. The tool refuses directories, protected paths, traversal,
symlinks, alternate case/Unicode spellings and files with additional hard links.
Filesystem permissions remain authoritative.

On `vault_mutation.version_conflict`, inspect the current source and reconcile
before any new deletion. On `trash_unavailable` or `cross_device`, inspect the
trash configuration/filesystem; failure never falls back to permanent deletion
or copying. An empty protected trash reservation can remain after a failed
operation. No automatic retry or reference repair occurs.

For an existing `note.md`, trash it using its current version:

```json
{"path":"note.md","ifMatch":"<current version>"}
```

Independently, permanently remove an existing `note.md` whose current content
has been selected for irreversible deletion:

```json
{"path":"note.md","permanent":true,"ifMatch":"<current version>"}
```

Related guides: `files`, `paths`, `references`. Related tools: `vault_read`,
`vault_list`, `reference_query`, `vault_move`.
<!-- /obsidian-help -->
