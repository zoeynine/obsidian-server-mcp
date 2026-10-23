# Transport boundary

MCP adapters validate protocol payloads and map results/errors. All filesystem,
path, version, parser, patch and semantic behavior belongs to src/core.
Transport code must never access node:fs directly.

Stdio registers thirteen Vault tools: vault_read_binary, vault_list, vault_read, vault_get_document_map,
search_query, reference_query, tag_list, vault_write, vault_append, vault_patch, vault_replace_text, vault_move and
vault_delete. Mutations go
through the shared core store; an embedded read-only composition may omit it.
No search_simple or specialized metadata tool is registered. Embedders opt into
binary reading through readBinary; createBinaryLink is the host-owned short-lived
HTTPS delivery interface. It is required for non-PDF generic auto downloads, explicit
links and image fallbacks; hosts offering only previews/bytes may omit it.
It does not add another MCP tool.
Embedders enable reference queries by injecting referenceQuery; its bounded
filesystem contract is documented in [reference queries](../../docs/reference-query.md).
The text/mutation contracts and differences are documented in the
[pinned Local REST 5.3.1 tables](../../docs/local-rest-5.3.1-parity.md).

One additional tool, obsidian_help, serves static guides from marked README
sections and canonical tool manuals from docs/tool-help.md. Omitted topic
returns Guides and Tools, with the actual names registered by this endpoint.
Every canonical and text alias tool name is a lookup topic; alias manuals
reuse the canonical content with presentation notes. Unknown topics return
a short error with the same endpoint-aware index. The help adapter has no
Vault dependencies or runtime filesystem/network access. Build-time generation
owns Markdown access; check:help detects stale generated content. Binary-enabled compositions expose
a version-pinned attachment resource template through the same guarded reader.
There is no attachment enumeration or alternate filesystem access route.
PDF paths are intentionally unsupported by all binary modes and the resource
reader; core returns unsupported_pdf with guidance to native client attachments.
Download hosts also apply core's assertBinaryPath policy to existing signed URLs.

Every default tool has strict input/output schemas. Text success uses structuredContent
only (empty content), without duplicate bodies. Binary success uses native image,
embedded-resource or resource-link content and compact metadata; binary data is
never copied into structuredContent. Targeted reads return
{path,version,result}, queries {results}, and mutations a compact OK receipt.
Mapped tool errors use isError: true and a single JSON text block with stable error codes,
messages and optional details. They omit structuredContent so clients do not validate
the error body against a success output schema; unexpected exceptions are sanitized.
SDK input/protocol errors remain SDK errors.

An embedding host may choose toolProfile: "text" in createVaultMcpServer's
second argument. This replaces vault_read / vault_list / vault_get_document_map /
search_query with their corresponding *_text names. Each alias shares its
original tool's schemas, use case and error mapping. All text-profile tools
validate successful output internally and omit outputSchema/structuredContent.
Ordinary data, help and mutation receipts emit compact JSON. Whole-file reads
emit metadata with textField: "content", followed by an unchanged raw text block;
heading/block reads use textField: "result" with the unchanged semantic reader
text. Empty bodies retain the second block. All frontmatter target values keep
single-block typed JSON. Binary metadata becomes a leading JSON text block while
native image/resource/resource_link blocks are retained. Both profiles expose
14 tools in a full composition, sharing names for ten tools and all operation
semantics. The standard profile's output contracts remain unchanged.
The standard stdio entry keeps the default profile. The existing enableTextRead
option remains compatible: it adds vault_read_text to the standard profile only,
giving 15 tools with the legacy single-block JSON reading contract, and does not
duplicate it in the text profile.

Options belong to each MCP server instance. A remote host can use fixed options
for separate endpoints, sharing one dependencies object and mutation store while
creating independent servers/transports. Each endpoint neither lists nor accepts
calls to the four names reserved for the other profile. Routing, OAuth discovery and authorization
remain host responsibilities; tool presentation is not a Vault permission boundary.

Core owns exact-byte ifMatch, per-path serialization, guarded sibling temporary
files, final revalidation, atomic publication and cleanup. No automatic mutation retry,
per-write permissions hook, directory durability state or policy module exists.
Deployment filesystem permissions determine read/write/delete access. Permission
failures become safe tool errors without exposing host paths. Transport does not
implement deployment authorization policy.

Stdio needs only OBSIDIAN_VAULT_ROOT. It supports raster image previews and
explicit non-PDF bytes; generic auto downloads, explicit links and image fallbacks fail
with link_unavailable until an embedding host supplies createBinaryLink.
Remote authentication, deployment,
permissions/inheritance and deployment filesystem qualification remain host
responsibilities. CI runs disposable-fixture tests on Windows and Linux.
