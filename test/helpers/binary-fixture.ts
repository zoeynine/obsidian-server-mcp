import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  VaultPathSandbox, VaultMutationStore, getVaultDocumentMap, listVaultFiles, listVaultTags,
  readVaultBinary, readVaultDocument, readVaultNote, searchVaultQuery, queryReferences,
} from "../../src/core/index.js";
import { serveVaultMcpStdio } from "../../src/transport/mcp/stdio.js";
import type { VaultBinaryLinkProvider, VaultBinaryReadUseCase } from "../../src/transport/mcp/vault-read-binary.js";
import type { ReferenceQueryUseCase } from "../../src/transport/mcp/reference-query.js";

export async function binaryFixture(t: TestContext) {
  const workspace = path.resolve(".test-dist");
  await mkdir(workspace, { recursive: true });
  const root = await mkdtemp(path.join(workspace, "binary-fixture-"));
  const vault = path.join(root, "vault");
  await mkdir(vault);
  const sandbox = await VaultPathSandbox.create(vault);
  t.after(async () => {
    const relative = path.relative(workspace, root);
    assert.ok(relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(root, { recursive: true, force: true });
  });
  return { root, vault, sandbox };
}

export async function binaryClient(t: TestContext, options: {
  createLink?: VaultBinaryLinkProvider;
  readBinary?: VaultBinaryReadUseCase;
  referenceQuery?: true | ReferenceQueryUseCase;
} = {}) {
  const fixture = await binaryFixture(t);
  const read = (p: string, o?: { maxBytes?: number }) => readVaultDocument(fixture.sandbox, p, o);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const handle = serveVaultMcpStdio({
    getDocumentMap: (p, o) => getVaultDocumentMap(read, p, o),
    listEntries: (p, o) => listVaultFiles(fixture.sandbox, p, o),
    readDocument: (p, o) => readVaultNote(read, p, o),
    searchQuery: (q, o) => searchVaultQuery(fixture.sandbox, read, q, o),
    tagList: o => listVaultTags(fixture.sandbox, read, o),
    ...(options.referenceQuery ? { referenceQuery: options.referenceQuery === true
      ? (input: Parameters<ReferenceQueryUseCase>[0]) => queryReferences(fixture.sandbox, read, input) : options.referenceQuery } : {}),
    mutations: await VaultMutationStore.create(fixture.sandbox),
    readBinary: options.readBinary ?? ((p, o) => readVaultBinary(fixture.sandbox, p, o)),
    ...(options.createLink ? { createBinaryLink: options.createLink } : {}),
  }, { transport: serverTransport });
  const client = new Client({ name: "binary-test", version: "1.0.0" });
  t.after(async () => { try { await client.close(); } finally { await handle.close(); } });
  await client.connect(clientTransport);
  return { ...fixture, client };
}

/** A self-contained, one-page PDF fixture; the product never parses it. */
export function pdfFixture(): Buffer {
  const stream = "BT /F1 18 Tf 40 100 Td (Attachment fixture 42) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let result = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, content] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${content}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, "0")} 00000 n \n`;
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
