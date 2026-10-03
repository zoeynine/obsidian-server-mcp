# Local REST 5.3.1 compatibility

The compatibility reference is
**Local REST 5.3.1**, annotated tag object
`7779963db3dfdf1e95f5a23d8475b86393973615`, peeled commit
`17a9cfd9ff5dd0156b694bf9b13ab36c786b29da`. No moving branch is the reference.

Primary sources at that immutable commit:

- [MCP registrations and text guards](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/17a9cfd9ff5dd0156b694bf9b13ab36c786b29da/src/mcpHandler.ts)
- [Vault operations and NoteJson/JsonLogic semantics](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/17a9cfd9ff5dd0156b694bf9b13ab36c786b29da/src/vaultOperations.ts)
- [Version metadata](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/17a9cfd9ff5dd0156b694bf9b13ab36c786b29da/package.json)
- [Dependency lock](https://github.com/coddingtonbear/obsidian-local-rest-api/blob/17a9cfd9ff5dd0156b694bf9b13ab36c786b29da/package-lock.json)

## Public tool table

This table covers ten text/discovery/mutation tools: five read tools and five
mutations through the shared store. An embedded read-only composition
can omit the store. No metadata policy module or external staging setup is required.
The additional `obsidian_help` tool serves static README topics only; it is a
server documentation extension with no Vault access, outside this parity table.
The `vault_read_binary` extension is documented in the README and
[deployment integration guide](binary-read-integration.md); `reference_query`
has its own [bounded reference contract](reference-query.md). Stock stdio exposes
13 tools including these extensions and `obsidian_help`.

| Tool | Pinned Local REST contract | Filesystem implementation / deliberate boundary |
| --- | --- | --- |
| `vault_list` | Optional directory `path`; `{files: string[]}` with `/` on directory names | Same names and shape; accepts a directory suffix. Sorted, bounded, complete-or-error. Includes real empty directories; omits symlinks, special and protected entries. A nonexistent directory is an error. |
| `vault_read` | Full NoteJson, or `targetType` + `target`, optional `scope` | Full filesystem-supported NoteJson plus exact-byte version. Targeted result uses `{path,version,result}` so scalar/array results have a stable object envelope. |
| `vault_get_document_map` | Nested `headings`, ordered `blocks`, `frontmatterFields`, `version` | Uses the pinned parser/projection, including duplicate addresses and setext headings. Adds path; replaces the six-hex parser hash with exact-byte SHA-256. The obsolete ATX-only parser is removed. |
| `vault_write` | `path`, text `content`; creates parents and unconditionally overwrites | Implemented through the shared commit layer. Existing files require `ifMatch`; no force bypass. Missing files reject a supplied token. |
| `vault_append` | `path`, text `content`; creates missing file; existing content receives LF first unless it ends in LF | Implemented through the shared commit layer, including the existing-empty-file LF case. Existing files require `ifMatch`; no transparent retries. |
| `vault_patch` | One generic instruction with operation, scope, target and one payload carrier | Generic preparation plus shared atomic commit, required exact-byte `ifMatch`, no retries. Frontmatter operation table below is covered by fixtures. Never a specialized metadata tool. |
| `search_query` | JsonLogic evaluated against each Markdown NoteJson; retains the truthy result | Pinned engine, with filesystem-supported fields and safety limits. Core array of `{filename,result,version}`; MCP `{results:[...]}` avoids protocol-dependent root-array wrapping. |
| `tag_list` | `{tags:[{name,count}]}`; names omit `#`, nested parents included | Same shape; shares parsed properties with NoteJson. Existing conservative inline lexer, deterministic case folding and per-file counts remain filesystem approximations of the Desktop cache. |
| `vault_move` | `path`, `destination`, optional `allowOverwrite` (false); `{message:"OK",oldPath,newPath}`; Desktop link/history updates | Same names, normalization, filename-preserving directory suffix, parent creation, overwrite flag and result. Optional source `ifMatch`. Filesystem move only; no link/history updates and no refusal based on backlinks. Same-filesystem only; details below. |
| `vault_delete` | `path`, optional `permanent` (false); `{message:"OK"}`; Desktop trash preference | Same names/default and permanent option. Default uses Vault-local `.trash`, without Desktop preference lookup. Adds path/permanent and recoverable trashPath receipt. Optional `ifMatch`. Regular files only; directory gap described below. |

Binary reads and reference queries extend the surface without changing these
text/mutation contracts. `search_simple` and Desktop/UI/event tools are not
exposed by this server.

## Targeted read table

`targetType` and `target` are paired; `scope` requires a target. Heading targets
are arrays of texts along the containment path. Like upstream, a JSON-encoded
array string is accepted for clients that stringify the argument; a bare
heading string is rejected. Block and property targets are strings. Default
scope is `content`. Duplicate map keys must be copied without reconstruction.

| Target | `content` | `marker` | `markerAndContent` |
| --- | --- | --- | --- |
| heading | Body, with heading levels relative to the target | Raw heading label | Whole subtree with levels relative to its parent |
| block | Block text | Bare block ID | Text plus ID span |
| frontmatter | Parsed JSON value | Property name | One-property JSON object |

A targeted response contains no full note body. Both full and targeted reads
use one bounded strict read and its exact-byte version. BOM is retained in full
text; parser wrappers omit it only while locating structure. Source bytes are
never normalized by the reader.

## NoteJson and query table

| Field / behavior | Filesystem implementation |
| --- | --- |
| `path`, `content` | Canonical relative path and complete strict UTF-8 text |
| `frontmatter` | YAML mapping converted to finite JSON, including nested arrays/objects |
| `tags` | String entries from the `tags` property plus direct inline tags, deduplicated with source spelling, without nested-parent expansion |
| `stat.ctime` | Filesystem birth time in milliseconds; zero when unavailable from the filesystem |
| `stat.mtime`, `stat.size` | File-handle modification time and exact byte length |
| `links`, `backlinks`, `unresolvedLinks` | Unavailable at the NoteJson root; absent from notes and explicitly rejected in queries, including computed access. Same-named properties in frontmatter/collection scope remain ordinary data. No fabricated empty link graph. |
| `var`, comparisons, coercion, missing/defaults, `if`, logical/collection/arithmetic/string operators | Pinned `json-logic-js` behavior; result values are not coerced to booleans |
| `glob` | Pinned `glob-to-regexp` with upstream default options: `*` crosses `/`, `?` is literal, case sensitive |
| `regexp` | JavaScript regexp, in a bounded worker |
| Result inclusion | Upstream filter: null/undefined, false, zero, empty string, empty array and empty object are omitted |
| Prototype traversal and `log` | Rejected / own-property lookup only; queries cannot access JS prototypes or write protocol stdout |

Queries are validated before traversal. Bounds are 16 KiB serialized input,
64 operator nodes, eight operator levels, 1,024 UTF-16 units per evaluated
literal string, and finite JSON values. Each invocation owns a worker with a
10-second startup bound, 2-second per-note evaluation bound, 128 MiB old-space
and 16 MiB young-space limits. At most four query workers are active. Every
worker is released on success or failure. Results have a fixed 4 MiB bound for
each evaluated value and aggregate accounting, including conservative per-result
overhead. Overflow returns `search_query.budget_exceeded` with
`budget: "maxOutputBytes"`; this is not a configurable input parameter. Crossing
a bound fails the invocation without partial output.

JsonLogic recognizes a single-key object as an operator expression. Multi-key
objects remain literal data; `{"a":1,"b":2}` returns that truthy object for every
scanned note. Use `and` or `or` to combine conditions.

Scan defaults / maxima remain 20,000 / 200,000 entries, 5,000 / 50,000 Markdown
files, 4 / 64 MiB per file and 64 MiB / 1 GiB total source bytes. Query results
default to 500, maximum 10,000. Tag results default to 5,000, maximum 50,000.
Each source has an independent exact-byte version; scans are not whole-Vault
transactions and do not create an index.

The filesystem evaluator always supplies the actual content from its safe read,
including for computed `var` access. It does not reproduce upstream's optimization
that empties `content` unless the serialized query contains the literal word.

Malformed/non-mapping YAML, aliases, anchors, explicit tags, complex keys,
duplicate keys and non-JSON values fail explicitly. This bounds expansion and
avoids disagreement between metadata parsing and the upstream structural
parser. `...` can terminate full-read metadata; structured targeting requires
the upstream `---` delimiter. Inline Markdown tags remain a conservative
subset rather than a claim to reproduce Obsidian's private parser.

## Generic frontmatter patch table

All these cases use `targetType: "frontmatter"`, a string `target`, and required
`ifMatch`. `scope` defaults to `content`. Validation and operation semantics
come from the pinned generic patch schema/engine. Preparation never writes a
file or retries a stale version. Payload JSON is bounded to 4 MiB.

| Scope | Operation | Carrier / effect |
| --- | --- | --- |
| content | replace | `value`: replace the property value |
| content | prepend / append | `value`: list concatenation, object merge or string concatenation in the requested order |
| content | delete | No carrier: retain key with null value |
| marker | replace | `content`: rename key; collisions fail |
| markerAndContent | replace | `value`: replace the anchor property's value |
| markerAndContent | prepend / append | `value` object: insert new properties before/after the anchor; collisions fail |
| markerAndContent | delete | No carrier: remove the property |
| other cells / multiple carriers / unknown fields | any | Rejected |

`createTargetIfMissing` follows upstream's cell rules; a missing property is
not implicitly created. `rejectIfContentPreexists` has upstream's text-only
meaning, not an invented frontmatter deduplication rule. There are no automatic
retries. Property edits preserve untouched property text, comments, body, BOM
and CRLF. The upstream semantic result is checked against the source-preserving
edit before returning it. Top-level flow mappings and prototype-named property
edits are refused instead of risking unrelated changes. Non-addressed comments
and an empty YAML block may remain after removal of the last property.

## Shared path and text policy

`VaultPathSandbox.parse/resolve` is the access policy entry point. Absolute
paths, parent traversal, noncanonical separators, Windows reserved names,
malformed Unicode, symlinks, physical escape and replacement of the original
Vault root are rejected. Dot-prefixed path components (including `.obsidian`,
`.git`, `.trash` and Sync state) are protected. Embedders can add protected
internal-state subtrees with `VaultPathSandbox.create(root, {protectedPaths: [...]})`; comparisons
use NFC and case folding. Discovery consults the same policy and omits protected
entries before reading/traversing them; they still consume traversal budgets.

Text reads and prepared edits reject NUL, malformed UTF-8/Unicode, and known
binary extensions. MIME families match the reference with an explicit
uncompressed `.svg` exception. Office/database/executable containers are also
blocked; unknown extensions must still pass strict decoding and NUL checks.

The resolver remains a policy/preflight primitive. `VaultMutationStore` composes
it with the commit sequence below. Mutation resolution also refuses existing
case/NFC aliases and hard-linked targets. Temporary files live on the target filesystem.
Use the exact case and Unicode spelling returned by `vault_list` when mutating
an existing path. Alternate spellings are refused even on a filesystem that
resolves them to the same file; this conservative rule also prevents collisions
on filesystems where those spellings identify distinct files.

## Shared lightweight mutation flow

1. Lock by physical Vault root and NFC/case-folded relative path across stores
   in the same process. Different paths can progress independently.
2. Safely read exact existing bytes and check SHA-256 `ifMatch`. Existing
   write/append and every patch require it. Missing-file creation rejects a
   supplied token. Validate the new text and byte limit before filesystem edits.
3. Create missing parent directories one checked component at a time. Write a
   complete, exclusively created `.obsidian-mcp-<random>.tmp` beside the target.
   File/directory creation uses normal OS defaults and inheritance. There are no
   ownership/mode/ACL preparation hooks or chown/chmod/setfacl calls.
4. Fsync the temporary file, close it, and revalidate parent identities, complete
   path policy, temporary identity, target metadata and exact-byte version.
   Detected changes abort; append/patch are never transparently retried.
5. Existing targets use one native rename/replace. New targets use atomic
   same-filesystem hard-link publication plus temp-name cleanup: Node has no
   rename NOREPLACE flag, and a concurrent create must not be overwritten.
   There is no copy fallback, destination unlink or publication retry.
6. Clean exact failed temp artifacts only after parent/file identity checks.
   A moved/replaced parent is never followed for cleanup. If cleanup cannot be
   completed, report it rather than deleting an unknown file. Empty new parent
   directories may remain. There is no recursive rollback or startup sweeper.

The hidden temporary names are protected by the common path policy, including
direct reads/mutations and list/query/tag discovery. A write failure before
publication retains the original note. Success retains Local REST's
`message: "OK"`, adding path, SHA-256 version, sizeBytes and created, plus any
patch warnings. The note body is not echoed. If a new note was published but its
extra hidden hard-link name could not be removed, return success with
`temporary_cleanup_failed`; do not misreport an unsaved append and invite retry.

There is no parent-directory fsync, durability-mode receipt, metadata-policy
loader or separate staging-root requirement. One pre-publication file fsync is
kept because it is a simple failure point before replacement; v1 does not claim
crash-consistent directory durability. The default stdio entry needs only the
Vault root and wires all five mutations through this store.

## Move and delete filesystem deltas

Move captures the normalized source/destination and acquires both process-local
locks in canonical order. It creates checked destination parents, revalidates
both paths and snapshots, then renames when `allowOverwrite: true`. It never
unlinks an existing destination first. With the default false flag, Node's lack
of rename-NOREPLACE requires hard-link publication followed by source unlink.
The destination cannot be clobbered by that publication; both names briefly
exist. Source unlink failure rolls back only the newly created destination link,
after verifying source and destination identities. Unsafe/failed cleanup returns
`source_cleanup_failed` with both relative paths; callers must inspect them
before retrying. No copy fallback, automatic retry, link rewriting or history
integration is attempted. An identical path is the upstream no-op (even if
missing); a supplied `ifMatch` still requires an existing matching file.

Recoverable delete reserves a unique `.trash/<timestamp-UUID>/` directory, then
revalidates and renames the file into it. This is Vault-local trash, independent
of Desktop settings. The compact receipt gives the recovery path; normal tools
cannot access protected trash. A failed operation removes its own empty trash
reservation where safe; an empty protected reservation may remain if cleanup
is denied. `permanent: true` uses checked unlink. Trash failure or cross-device
rename never falls back to permanent deletion or copying.

Move and delete accept attachments without text decoding. Optional `ifMatch`
hashes exact bytes with a 64 MiB cap; omission retains upstream current-path
behavior without a content read or size cap. Every operation rejects symlinks,
protected paths and additional hard links. Both are file operations here.
Upstream move requires a TFile; upstream recoverable delete's implementation can
also accept a TFolder despite its file-oriented public description. This server
rejects directories because a whole-tree move/delete could bypass protected
descendant checks. Recursive folder deletion is not implemented.

## Deployment permissions and Linux qualification

Deployment filesystem permissions are authoritative for what the MCP process
may read, write and delete. Authorization belongs to the environment's process
identity, groups, ACLs, mounts or container configuration. Generic containment,
symlink and protected-internal checks are separate correctness/security boundaries.

Same-directory temporary creation naturally uses the destination directory's
owner/group/default-ACL settings. MCP neither preserves old per-file ACLs nor
actively reassigns them. Linux validation must check allowed/denied operations
and inheritance for the actual process identity and filesystem. Rename, move
and delete are controlled by directory permissions as well as platform-specific
rules; a file's read-only mode alone does not imply it cannot be renamed or deleted.
Existing files moved or trashed retain their inode metadata. No permissions or
ACLs are changed by the implementation. Permission tests use disposable fixtures.

Native Linux symlink/race, same-filesystem publication and permission-inheritance
behavior needs validation for each deployment's identity and filesystem.
Process-local serialization and a
final version check are not cross-process CAS with arbitrary Sync writes after
that checkpoint. Path revalidation remains mandatory; Node path-based syscalls
do not lock out an adversary renaming writable ancestor directories between
syscalls. The deployment filesystem permissions must provide a trusted directory
namespace. These limits are documented, not replaced with per-write ACL machinery.

## Dependency rationale and verification

Added exact versions match the upstream lock: `markdown-patch` 2.0.0 for one
address/operation grammar, `yaml` 2.9.1 for properties and positioned edits,
`json-logic-js` 2.0.5 for value semantics, `glob-to-regexp` 0.4.1 for its custom
operator, and `mime-types` 2.1.35 for text/binary classification. The updated
lockfile also matches upstream's `marked` 17.0.6 and `mime-db` 1.52.0. No Desktop
runtime, search DB, native mutation dependency or deployment package was added.

Evidence lives in `test/core/local-rest-parity.test.ts`,
`test/core/vault-mutations.test.ts`, `test/core/vault-file-operations.test.ts`, the existing bounded reader/list/scanner
tests, and `test/transport/vault-mcp.test.ts`. Retired
predicate-only and duplicate-text assertions were replaced by parity and
compact-output assertions, not retained as compatibility requirements.
All tests use disposable fixtures. The supported deployment target is Linux;
CI checks Node 22 and 24 on Linux. Windows is an optional local development
environment. Deployment-specific permissions and authentication need separate
validation. For code, dependency, build or test changes, run `npm run check`
once locally; additional platform validation depends on the affected behavior
or release needs. Documentation-only changes need a focused readback.
