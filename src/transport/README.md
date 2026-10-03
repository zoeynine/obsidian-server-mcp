# Transport boundary

MCP adapters validate protocol payloads and map results/errors. All filesystem,
path, version, parser, patch and semantic behavior belongs to src/core.
Transport code must never access node:fs directly.

Stdio registers twelve Vault tools: vault_read_binary, vault_list, vault_read, vault_get_document_map,
search_query, reference_query, tag_list, vault_write, vault_append, vault_patch, vault_move and
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

One additional tool, obsidian_help, serves only static usage topics generated
from marked sections of the repository README. Omitted topic returns an index;
unknown topic returns a short error/index. It has no Vault dependencies or
runtime filesystem/network access. Build-time generation owns README access;
check:help detects stale generated content. Binary-enabled compositions expose
a version-pinned attachment resource template through the same guarded reader.
There is no attachment enumeration or alternate filesystem access route.
PDF paths are intentionally unsupported by all binary modes and the resource
reader; core returns unsupported_pdf with guidance to native client attachments.
Download hosts also apply core's assertBinaryPath policy to existing signed URLs.

Every tool has strict input/output schemas. Text success uses structuredContent
only (empty content), without duplicate bodies. Binary success uses native image,
embedded-resource or resource-link content and compact metadata; binary data is
never copied into structuredContent. Targeted reads return
{path,version,result}, queries {results}, and mutations a compact OK receipt.
Known errors have stable codes with short text and structured payloads;
unexpected exceptions are sanitized. SDK input/protocol errors remain SDK errors.

Core owns exact-byte ifMatch, per-path serialization, guarded sibling temporary
files, final revalidation, atomic publication and cleanup. No append/patch retry,
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
