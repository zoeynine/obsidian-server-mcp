# Bounded filesystem references

`reference_query` finds
references to one exact file, heading or block, without modifying files or
maintaining a persistent graph. It is not Obsidian Desktop's link resolver.
The executable entry/help examples live in README's `references` topic.

## Scope and result contract

`scope: {directory, recursive}` and `target: {path, heading? | block?}` are required.
The directory is a canonical Vault-relative directory (`""` is root), recursion
is an explicit boolean, and the target path names a file including its extension.
`resolutionScope` has the same shape and defaults to `scope`.

Only source-scope Markdown bodies and the explicit target are read. Filename
resolution inventories regular files, including attachments, in the resolution
scope. If that inventory covers the source scope, the inventory is reused;
otherwise both enumerations consume the shared entry/file budget. Protected,
symbolic-link and non-regular entries are never followed. A recursive root
inventory covers the accessible namespace, not hidden/protected Desktop data.

`matches` contains only confirmed links to the requested target. A file query
includes supported links to its existing headings/blocks. A heading/block query
requires that exact anchor, not a link to the containing file or another anchor.
`uncertain` contains all recognized uncertain internal occurrences in the source
scope, including ones that may not refer to the requested target. This prevents
discarding potential incoming references whose identity cannot be established.

Each occurrence has `source: {path, version}`, `raw`, `href`, `syntax`, `embed`,
`start/end`, `line/column`, `status/reason`, and, when known, `destination` or
`candidates`. Offsets are zero-based, half-open JavaScript UTF-16 string indices
into the exact source returned by a read, including BOM/CRLF. Lines and UTF-16
columns are one-based. `source.slice(start, end) === raw`. They are not UTF-8
byte offsets, normalized Markdown offsets or coordinates in rendered text.

| Status | Meaning |
| --- | --- |
| resolved | The supported file/anchor is uniquely established under this contract |
| ambiguous | Multiple known filename/heading/block candidates; no proximity or first-match guess |
| unresolved | An explicit file/anchor is absent, or a complete accessible filename inventory has no match |
| unknown | Resolution would require a wider candidate inventory or an out-of-scope file |
| unsupported | Recognized occurrence uses unsupported syntax, fragment semantics or an unsafe path |

`target.fileExists` reports file existence; `target.status/reason` reports the
requested anchor as well. A missing target is queryable, so dangling references
can be examined. A target outside source/resolution scopes is still explicitly
authorized for inspection. Its existence alone cannot prove a bare name unique.
`coverage.complete` means the call completed its bounded, supported operation;
`incomingOutsideScope` is always `unknown`, and `atomicSnapshot` is always false.

## Syntax and resolution matrix

| Form | Contract |
| --- | --- |
| `[[Note]]`, `[[Note.md]]` | Exact basename among the filename inventory; root/recursive coverage required to call one candidate resolved |
| `[[folder/Note]]` | Explicit Vault-root-relative path; `.md` inferred when no extension is present |
| `[[./Note]]`, `[[../Note]]` | Relative to the referring note; parent segments normalized before sandbox validation, never above root |
| `[label](../Note%20Name.md)` | CommonMark escaping/entities and reference definitions; URL percent-decoding once; relative to referring note |
| `/folder/Note.md` in a link | Vault-root-relative link syntax, never a host absolute filesystem path |
| `[[#Heading]]`, `[[Note#Parent#Child]]` | Same-file or explicit-file anchor; exact plain heading labels and consecutive ancestry suffix; duplicates remain ambiguous |
| `[[Note#^id]]` | Latin letters, digits and hyphens; block attachment follows the existing structural parser; duplicate IDs ambiguous |
| Wikilink display labels | Display only; pipe escaping in table source is accepted; label does not participate in resolution |
| frontmatter `aliases` | No alias-name expansion or inference that `[[Alias]]` names a particular file |
| `![[...]]`, `![label](...)`, reference images | Embed flag plus the same destination rules; dimensions/display suffix do not change file identity |
| attachments | Existence only; no binary decoding, PDF extraction, media page/time anchor validation or network fetch |
| formatted/entity-containing headings, headings or Markdown links overlapping comments/math, percent-encoded fragment separators, page/time fragments, nested/unclosed wikilinks, custom URI schemes | Unsupported rather than a guessed target |

Frontmatter, CommonMark code/HTML, Obsidian `%%` comments, balanced dollar math
and ordinary external URLs are excluded. Raw HTML links, plugin-generated
references, Canvas/other non-Markdown source contents and rendering-specific
extensions are outside coverage. Unbound Markdown reference labels remain
literal CommonMark text. Known unsupported occurrences are returned; this is not
a promise to discover every plugin's syntax. Markdown parsing precedence is
conservative when wikilinks overlap another link or code span.

Native syntax references: [internal links](https://obsidian.md/help/links),
[aliases](https://obsidian.md/help/aliases), [embeds](https://obsidian.md/help/embeds).
These establish syntax families, not a claim to reproduce undocumented Desktop
resolution choices. `vault_get_document_map` duplicate markers are MCP addresses,
not link fragments.

## Resources, failures and concurrency

The public numeric limits are in `REFERENCE_LIMITS` and the help topic. Entry
counts include entries encountered during directory enumeration; file counts
bound inventoried regular files, including attachments. Target reads (including
the final version recheck) and source reads consume the same total-byte budget.
Matches and uncertainties consume one shared count/output-byte budget.

A call uses one parser worker, with at most four such workers, 128 MiB old heap,
16 MiB young heap, 4 MiB stack, 10 seconds startup and 2 seconds per parse.
Additional limits: 100,000 AST nodes, 10,000 links/targets per document, 16,384
UTF-16 units per link, eight opaque-region parsing passes, 50,000 visited links
per query, and a 30-second query deadline checked between bounded operations.
Filesystem operations are not forcibly interrupted at the deadline.

Errors never return successful partial arrays. Unsafe query paths are rejected;
unsafe link destinations are marked unsupported without escaping the sandbox.
Detected directory changes fail the inventory/query, and the target is rechecked
before returning. Sources retain the exact versions observed during their safe
reads; a later edit need not invalidate that earlier observation. These checks
do not create a multi-file transaction or prevent a change after verification.

`mdast-util-from-markdown` 2.0.2 is the only new direct dependency. Its positioned
CommonMark tree distinguishes links from code and provides exact source spans;
the existing `markdown-patch` model does not expose links. Reusing that model for
heading hierarchy/block attachment preserves the established structural boundary.
Obsidian wikilink extraction and resolution remain in `src/core/reference`.

Search-result locators and link-repair preview/apply are not part of this tool.
