import * as assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import { Client, type JsonSchemaType } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { computeContentVersion, getVersionGuard } from "../../src/core/version/content-version.js";
import { readToolError } from "./tool-error.js";

test("stdio wire errors omit structuredContent while mutation success still matches its declared schema", async t => {
  const workspace = path.resolve(".test-dist");
  await mkdir(workspace, { recursive: true });
  const vault = await mkdtemp(path.join(workspace, "error-contract-vault-"));
  const client = new Client({ name: "error-contract-stdio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(".test-dist/src/stdio-main.js")], env: { OBSIDIAN_VAULT_ROOT: vault }, stderr: "pipe" });
  t.after(async () => {
    try { await client.close(); } finally { await rm(vault, { recursive: true, force: true }); }
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const append = tools.find(tool => tool.name === "vault_append")!;
  assert.ok(append.outputSchema);
  const required = append.outputSchema["required"];
  assert.ok(Array.isArray(required));
  assert.deepEqual([...required].sort(),
    ["beforeSizeBytes", "created", "message", "path", "sizeBytes", "version", "versionGuard"]);
  assert.equal(append.outputSchema["additionalProperties"], false);
  // tools/list supplied JSON; the SDK wire type's optional undefined values cannot occur here.
  const validateReceipt = new AjvJsonSchemaValidator().getValidator(append.outputSchema as JsonSchemaType);

  // Observe parsed JSON-RPC directly at stdio, before Client's result validation or transformations.
  const received: unknown[] = [];
  const onmessage = transport.onmessage;
  transport.onmessage = message => {
    if ("result" in message) received.push(structuredClone(message.result));
    onmessage?.(message);
  };
  async function call(name: string, args: Record<string, unknown>) {
    received.length = 0;
    const result = await client.callTool({ name, arguments: args });
    assert.equal(received.length, 1);
    const wire = received[0] as typeof result;
    assert.deepEqual(wire, result);
    return wire;
  }

  const source = "# Present\nbody";
  const file = path.join(vault, "note.md");
  await writeFile(file, source);
  const version = computeContentVersion(source);
  const staleVersion = computeContentVersion("stale");
  const missingVersion = readToolError(await call("vault_append", { path: "note.md", content: "next" }));
  assert.equal(missingVersion.code, "vault_mutation.if_match_required");
  assert.match(missingVersion.message, /require ifMatch/u);
  assert.deepEqual(missingVersion.details, { path: "note.md" });

  const missingHeading = readToolError(await call("vault_patch", { path: "note.md", targetType: "heading",
    target: ["Missing"], operation: "replace", content: "new", ifMatch: version }));
  assert.equal(missingHeading.code, "vault_semantic.TargetNotFoundError");
  assert.match(missingHeading.message, /full heading path from the top level/u);

  const stale = readToolError(await call("vault_append", { path: "note.md", content: "next", ifMatch: staleVersion }));
  assert.equal(stale.code, "vault_mutation.version_conflict");
  assert.equal(stale.message, "Content version does not match ifMatch");
  assert.deepEqual(stale.details, { path: "note.md", expected: staleVersion, actual: version });

  const bounded = readToolError(await call("vault_read", { path: "note.md", maxBytes: 1 }));
  assert.equal(bounded.code, "vault_read.too_large");
  assert.match(bounded.message, /maxBytes limits the entire source file/u);
  assert.deepEqual(bounded.details, { path: "note.md", maxBytes: 1,
    observedSizeBytes: Buffer.byteLength(source) });
  assert.ok(bounded.details);
  const recovered = await call("vault_read", { path: "note.md", maxBytes: bounded.details["observedSizeBytes"] });
  assert.notEqual(recovered.isError, true);
  const body = recovered.structuredContent;
  assert.ok(body && typeof body === "object" && "content" in body);
  assert.equal(body.content, source);
  for (const error of [missingVersion, missingHeading, stale, bounded]) {
    assert.equal(JSON.stringify(error).includes(vault), false);
    assert.doesNotMatch(JSON.stringify(error), /"stack"|node_modules/u);
  }
  assert.equal(await readFile(file, "utf8"), source);

  const successful = await call("vault_append", { path: "note.md", content: "next", ifMatch: version });
  assert.notEqual(successful.isError, true);
  assert.equal(Object.hasOwn(successful, "structuredContent"), true);
  assert.deepEqual(successful.content, []);
  const expected = source + "\nnext";
  assert.deepEqual(successful.structuredContent, { message: "OK", path: "note.md", version: computeContentVersion(expected), versionGuard: getVersionGuard(computeContentVersion(expected)),
    beforeSizeBytes: Buffer.byteLength(source), sizeBytes: Buffer.byteLength(expected), created: false });
  const validation = validateReceipt(successful.structuredContent);
  assert.equal(validation.valid, true, validation.errorMessage);
  assert.equal(await readFile(file, "utf8"), expected);
});
