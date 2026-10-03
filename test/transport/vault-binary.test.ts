import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MAX_BINARY_BYTES, computeContentVersion, type VaultBinaryReference } from "../../src/core/index.js";
import { VAULT_READ_BINARY_TOOL_NAME } from "../../src/transport/mcp/vault-read-binary.js";
import { binaryClient, binaryFixture, pdfFixture } from "../helpers/binary-fixture.js";

const tool = VAULT_READ_BINARY_TOOL_NAME;
const validLink = () => ({ uri: "https://attachments.example.invalid/read?token=fixture", expiresAt: new Date(Date.now() + 60_000).toISOString() });

test("binary tool discovery is compact, strictly typed and read-only alongside the existing eleven tools", async t => {
  let calls = 0;
  const { client } = await binaryClient(t, { readBinary: async () => { calls++; throw new Error("must not run"); } });
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 12);
  const entry = tools.find(item => item.name === tool)!;
  assert.deepEqual(Object.keys(entry.inputSchema.properties ?? {}), ["path", "as"]);
  assert.equal(entry.annotations?.readOnlyHint, true);
  assert.equal(entry.annotations?.destructiveHint, false);
  assert.ok(entry.outputSchema);
  for (const args of [{}, { path: 1 }, { path: "a", as: "text" }, { path: "a", extra: true }]) {
    assert.equal((await client.callTool({ name: tool, arguments: args })).isError, true);
  }
  assert.equal(calls, 0);
});

test("explicit bytes travel once as an embedded resource and can be re-read by a version-pinned URI", async t => {
  const { client, vault } = await binaryClient(t, { createLink: async () => { throw new Error("bytes must not request a link"); } });
  const name = "附件/文 件 #%.bin";
  const data = Buffer.from([0, 0xff, 0xc3, 0x28, 0xfe]);
  await mkdir(path.join(vault, "附件"));
  await writeFile(path.join(vault, name), data);
  const result = await client.callTool({ name: tool, arguments: { path: name, as: "bytes" } });
  assert.notEqual(result.isError, true);
  assert.equal(metadata(result)["delivery"], "bytes");
  assert.equal(metadata(result)["mimeType"], "application/octet-stream");
  assert.equal(result.content.length, 1);
  const item = result.content[0];
  assert.ok(item?.type === "resource" && "blob" in item.resource);
  assert.deepEqual(Buffer.from(item.resource.blob, "base64"), data);
  assert.equal(JSON.stringify(result.structuredContent).includes(data.toString("base64")), false);
  const again = await client.readResource({ uri: item.resource.uri });
  const resource = again.contents[0];
  assert.ok(resource && "blob" in resource);
  assert.deepEqual(Buffer.from(resource.blob, "base64"), data);
  await writeFile(path.join(vault, name), Buffer.concat([data, Buffer.from("\n")]));
  await assert.rejects(client.readResource({ uri: item.resource.uri }), /version_conflict/u);
  assert.ok(client.getServerCapabilities()?.resources);
  assert.equal((await client.listResources()).resources.length, 0);
});

test("images are native MCP image content with compact original/preview metadata", async t => {
  const { client, vault } = await binaryClient(t, { createLink: async () => { throw new Error("previews must not request a link"); } });
  await writeFile(path.join(vault, "preview.png"), await sharp({ create: {
    width: 40, height: 20, channels: 3, background: "#ff8040",
  } }).png().toBuffer());
  const result = await client.callTool({ name: tool, arguments: { path: "preview.png" } });
  assert.notEqual(result.isError, true);
  assert.equal(metadata(result)["delivery"], "image");
  assert.equal(metadata(result)["preview"], true);
  const item = result.content[0];
  assert.ok(item?.type === "image");
  assert.equal(item.mimeType, "image/webp");
  assert.equal((await sharp(Buffer.from(item.data, "base64")).metadata()).width, 40);
  assert.equal(JSON.stringify(result.structuredContent).includes(item.data), false);
});

test("attachment resources cannot bypass path protection or inject extra URI fields", async t => {
  const { client, vault } = await binaryClient(t);
  await mkdir(path.join(vault, ".private"));
  await writeFile(path.join(vault, ".private", "secret.pdf"), pdfFixture());
  const version = "sha256:" + "0".repeat(64);
  for (const name of [".private/secret.pdf", "../outside.pdf"]) {
    const uri = "obsidian-vault://attachment/" + encodeURIComponent(name) + "?version=" + encodeURIComponent(version);
    await assert.rejects(client.readResource({ uri }), /vault_path\./u);
  }
  const altered = "obsidian-vault://attachment/test.pdf?version=" + encodeURIComponent(version) + "&extra=1";
  await assert.rejects(client.readResource({ uri: altered }));
});

test("PDF tools and legacy resource URIs reject delivery in every mode with or without a provider", async t => {
  let providerCalls = 0;
  const data = pdfFixture();
  for (const withProvider of [false, true]) {
    const { client, vault } = await binaryClient(t, withProvider ? {
      createLink: async () => { providerCalls++; return validLink(); },
    } : {});
    for (const name of ["报告.pdf", "UPPER.PDF"]) {
      await writeFile(path.join(vault, name), data);
      for (const options of [{}, { as: "auto" }, { as: "bytes" }, { as: "link" }] as const) {
        const result = await client.callTool({ name: tool, arguments: { path: name, ...options } });
        assert.equal(result.isError, true);
        const error = metadata(result)["error"] as { code: string; message: string };
        assert.equal(error.code, "vault_read_binary.unsupported_pdf");
        assert.match(error.message, /client.*native file upload or attachment/u);
        assert.ok(result.content.every(item => item.type === "text"));
        assert.equal(JSON.stringify(result).includes(data.toString("base64")), false);
      }
      const uri = "obsidian-vault://attachment/" + encodeURIComponent(name) +
        "?version=" + encodeURIComponent(computeContentVersion(data));
      await assert.rejects(client.readResource({ uri }), /vault_read_binary\.unsupported_pdf/u);
    }
  }
  assert.equal(providerCalls, 0);
});

test("non-PDF generic auto downloads use the same provider as explicit links without embedding bytes", async t => {
  const references: VaultBinaryReference[] = [];
  const { client, vault } = await binaryClient(t, { createLink: async ref => { references.push(ref); return validLink(); } });
  for (const [name, data, mimeType] of [
    ["文 件 #%.zip", Buffer.from([0x50, 0x4b, 0x05, 0x06]), "application/zip"],
    ["small.blob", Buffer.from([0xff, 0, 0xfe]), "application/octet-stream"],
    ["vector.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"],
  ] as const) {
    await writeFile(path.join(vault, name), data);
    for (const options of [{}, { as: "auto" }, { as: "link" }] as const) {
      const result = await client.callTool({ name: tool, arguments: { path: name, ...options } });
      assert.notEqual(result.isError, true);
      assert.equal(result.content.length, 1);
      const item = result.content[0];
      assert.ok(item?.type === "resource_link");
      assert.equal(item.name, name);
      assert.equal(item.mimeType, mimeType);
      assert.equal(item.size, data.byteLength);
      assert.deepEqual(metadata(result), { path: name, mimeType, sizeBytes: data.byteLength,
        delivery: "link", uri: item.uri, expiresAt: metadata(result)["expiresAt"],
        reason: "as" in options && options.as === "link" ? "requested" : "download" });
      assert.deepEqual(references.at(-1), { path: name, mimeType, sizeBytes: data.byteLength });
    }
  }
  assert.equal(references.length, 9);
});

test("missing integration fails explicitly for default downloads, image fallbacks and requested links", async t => {
  const { client, vault } = await binaryClient(t);
  await writeFile(path.join(vault, "small.bin"), Buffer.from([0xff, 0]));
  await writeFile(path.join(vault, "empty.blob"), Buffer.alloc(0));
  await writeFile(path.join(vault, "large.bin"), Buffer.alloc(MAX_BINARY_BYTES + 1));
  await writeFile(path.join(vault, "invalid.png"), Buffer.from("not a raster image"));
  for (const args of [{ path: "small.bin" }, { path: "small.bin", as: "auto" },
    { path: "small.bin", as: "link" }, { path: "empty.blob" }, { path: "large.bin" }, { path: "invalid.png" }]) {
    const result = await client.callTool({ name: tool, arguments: args });
    assert.equal(result.isError, true);
    assert.equal((metadata(result)["error"] as { code: string }).code, "vault_read_binary.link_unavailable");
    assert.doesNotMatch(JSON.stringify(result), /file:\/\/|https:\/\//u);
  }
});

test("image preview fallbacks preserve the exact source version for the download provider", async t => {
  const references: VaultBinaryReference[] = [];
  const { client, vault } = await binaryClient(t, { createLink: async ref => { references.push(ref); return validLink(); } });
  const data = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(path.join(vault, "disguised.png"), data);
  const result = await client.callTool({ name: tool, arguments: { path: "disguised.png" } });
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]?.type, "resource_link");
  assert.equal(metadata(result)["reason"], "image_preview_unavailable");
  assert.equal(metadata(result)["version"], computeContentVersion(data));
  assert.deepEqual(references, [{ path: "disguised.png", mimeType: "image/png",
    sizeBytes: data.byteLength, version: computeContentVersion(data) }]);
});

test("link providers receive only a guarded relative reference, and unsafe paths never reach them", async t => {
  const references: VaultBinaryReference[] = [];
  const { client, vault } = await binaryClient(t, { createLink: async ref => { references.push(ref); return validLink(); } });
  await writeFile(path.join(vault, "attachment.bin"), Buffer.from([0xff, 0]));
  const result = await client.callTool({ name: tool, arguments: { path: "attachment.bin", as: "link" } });
  assert.notEqual(result.isError, true);
  assert.equal(result.content[0]?.type, "resource_link");
  assert.equal(metadata(result)["delivery"], "link");
  assert.equal(references.length, 1);
  assert.deepEqual(Object.keys(references[0]!).sort(), ["mimeType", "path", "sizeBytes"]);
  assert.equal(references[0]?.path, "attachment.bin");
  for (const as of ["auto", "link"] as const) {
    for (const input of ["../outside.bin", ".obsidian/secret.bin", "missing.bin"]) {
      const rejected = await client.callTool({ name: tool, arguments: { path: input, as } });
      assert.equal(rejected.isError, true);
      assert.ok(!JSON.stringify(rejected).includes(vault));
    }
  }
  assert.equal(references.length, 1);
});

test("links must be expiring HTTPS URLs without embedded credentials or fragments", async t => {
  const invalid = [
    { ...validLink(), uri: "file:///private/secret" },
    { ...validLink(), uri: "http://localhost/download" },
    { ...validLink(), uri: "https://user:password@example.invalid/download" },
    { ...validLink(), uri: "https://example.invalid/download#secret" },
    { ...validLink(), expiresAt: new Date(Date.now() - 1_000).toISOString() },
    { ...validLink(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
    { ...validLink(), expiresAt: "not-a-date" },
  ];
  let current = invalid[0]!;
  const { client, vault } = await binaryClient(t, { createLink: async () => current });
  await writeFile(path.join(vault, "attachment.bin"), Buffer.from([0]));
  for (current of invalid) {
    for (const as of ["auto", "link"] as const) {
      const result = await client.callTool({ name: tool, arguments: { path: "attachment.bin", as } });
      assert.equal(result.isError, true);
      assert.equal((metadata(result)["error"] as { code: string }).code, "vault_read_binary.invalid_link");
      assert.ok(!JSON.stringify(result).includes("password"));
    }
  }
});

test("read, permission and provider failures are sanitized and never retried", async t => {
  let attempts = 0;
  const secret = "D:/private-vault/secret.bin";
  const { client, vault } = await binaryClient(t, { createLink: async () => { attempts++; throw new Error(secret); } });
  await writeFile(path.join(vault, "attachment.bin"), Buffer.from([0xff, 0]));
  for (const as of ["auto", "link"] as const) {
    const failedLink = await client.callTool({ name: tool, arguments: { path: "attachment.bin", as } });
    assert.equal((metadata(failedLink)["error"] as { code: string }).code, "vault_read_binary.link_failed");
    assert.ok(!JSON.stringify(failedLink).includes(secret));
  }
  assert.equal(attempts, 2);
  for (const code of ["EACCES", "EPERM", "EIO"]) {
    const denied = await binaryClient(t, { readBinary: async () => { throw Object.assign(new Error(secret), { code }); } });
    const result = await denied.client.callTool({ name: tool, arguments: { path: "attachment.bin" } });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal((metadata(result)["error"] as { code: string }).code,
      code === "EIO" ? "vault_read_binary.internal_error" : "vault_read_binary.permission_denied");
  }
});

function metadata(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(typeof result.structuredContent === "object" && result.structuredContent !== null);
  return result.structuredContent as Record<string, unknown>;
}

test("stock stdio refuses all PDF modes while non-PDF bytes, links and previews retain their contracts", async t => {
  const fixture = await binaryFixture(t);
  const data = Buffer.from([0xff, 0, 0xfe]);
  await writeFile(path.join(fixture.vault, "fixture.bin"), data);
  await writeFile(path.join(fixture.vault, "fixture.pdf"), pdfFixture());
  await writeFile(path.join(fixture.vault, "fixture.png"), await sharp({ create: {
    width: 16, height: 8, channels: 3, background: "blue",
  } }).png().toBuffer());
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(".test-dist/src/stdio-main.js")], env: { OBSIDIAN_VAULT_ROOT: fixture.vault }, stderr: "pipe" });
  const client = new Client({ name: "binary-stdio-test", version: "1.0.0" });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 13);
  for (const options of [{}, { as: "auto" }, { as: "bytes" }, { as: "link" }] as const) {
    const rejected = await client.callTool({ name: tool, arguments: { path: "fixture.pdf", ...options } });
    assert.equal(rejected.isError, true);
    assert.equal((metadata(rejected)["error"] as { code: string }).code, "vault_read_binary.unsupported_pdf");
  }
  const download = await client.callTool({ name: tool, arguments: { path: "fixture.bin" } });
  assert.equal(download.isError, true);
  assert.equal((metadata(download)["error"] as { code: string }).code, "vault_read_binary.link_unavailable");
  const bytes = await client.callTool({ name: tool, arguments: { path: "fixture.bin", as: "bytes" } });
  assert.notEqual(bytes.isError, true);
  assert.equal(metadata(bytes)["delivery"], "bytes");
  const item = bytes.content[0];
  assert.ok(item?.type === "resource" && "blob" in item.resource);
  assert.deepEqual(Buffer.from(item.resource.blob, "base64"), data);
  const image = await client.callTool({ name: tool, arguments: { path: "fixture.png" } });
  assert.equal(image.content[0]?.type, "image");
});
