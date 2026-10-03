import assert from "node:assert/strict";
import { mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
  MAX_BINARY_BYTES, MAX_BINARY_IMAGE_BYTES, MAX_BINARY_IMAGE_EDGE,
  readVaultBinary, computeContentVersion, readVaultDocument, VaultPathError, VaultBinaryError,
  VaultDocumentTooLargeError, VaultDocumentNotFoundError, VaultDocumentNotRegularFileError,
} from "../../src/core/index.js";
import { binaryFixture, pdfFixture } from "../helpers/binary-fixture.js";

test("explicit bytes preserve arbitrary bytes, exact versions and unknown MIME fallback", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  const data = Buffer.from([0xff, 0, 0xfe, 0xc3, 0x28]);
  await writeFile(path.join(vault, "原件.blob"), data);
  const result = await readVaultBinary(sandbox, "原件.blob", { as: "bytes" });
  assert.ok(result.kind === "bytes");
  assert.deepEqual(result.data, data);
  assert.equal(result.mimeType, "application/octet-stream");
  assert.equal(result.version, computeContentVersion(data));
  await assert.rejects(readVaultDocument(sandbox, "原件.blob"));
  assert.deepEqual(await readFile(path.join(vault, "原件.blob")), data);
});

test("PDF paths fail before reading in every mode, including uppercase, empty, oversized and absent files", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  await writeFile(path.join(vault, "报告.pdf"), pdfFixture());
  await writeFile(path.join(vault, "empty.PDF"), Buffer.alloc(0));
  const large = await open(path.join(vault, "large.PdF"), "w");
  try { await large.truncate(MAX_BINARY_BYTES + 1); } finally { await large.close(); }
  for (const name of ["报告.pdf", "empty.PDF", "large.PdF", "absent.pdf"]) {
    for (const options of [{}, { as: "auto" }, { as: "bytes" }, { as: "link" }] as const) {
      await assert.rejects(readVaultBinary(sandbox, name, options), error => {
        assert.ok(error instanceof VaultBinaryError);
        assert.equal(error.code, "unsupported_pdf");
        assert.match(error.message, /client.*native file upload or attachment/u);
        return true;
      });
    }
  }
});

test("non-PDF generic attachments use download links even when small or empty", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  for (const [name, data, mimeType] of [
    ["archive.zip", Buffer.from([0x50, 0x4b, 0x05, 0x06]), "application/zip"],
    ["原件.blob", Buffer.from([0xff, 0, 0xfe]), "application/octet-stream"],
    ["empty.bin", Buffer.alloc(0), "application/octet-stream"],
    ["vector.svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"],
  ] as const) {
    await writeFile(path.join(vault, name), data);
    for (const options of [{}, { as: "auto" }, { as: "link" }] as const) {
      assert.deepEqual(await readVaultBinary(sandbox, name, options), {
        path: name, mimeType, sizeBytes: data.byteLength, kind: "link",
        reason: "as" in options && options.as === "link" ? "requested" : "download",
      });
    }
  }
});

test("image auto produces a bounded preview while bytes and source versions remain original", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  const data = await sharp({ create: { width: 2800, height: 1400, channels: 4, background: "#356abd80" } }).png().toBuffer();
  await writeFile(path.join(vault, "large.png"), data);
  const result = await readVaultBinary(sandbox, "large.png");
  assert.ok(result.kind === "image");
  assert.equal(result.outputMimeType, "image/webp");
  assert.equal(result.width, MAX_BINARY_IMAGE_EDGE);
  assert.equal(result.height, MAX_BINARY_IMAGE_EDGE / 2);
  assert.equal(result.firstFrameOnly, false);
  assert.ok(result.data.byteLength <= MAX_BINARY_IMAGE_BYTES);
  const decoded = await sharp(result.data).metadata();
  assert.equal(decoded.format, "webp");
  assert.equal(decoded.width, result.width);
  assert.equal(decoded.hasAlpha, true);
  assert.equal(result.version, computeContentVersion(data));
  const original = await readVaultBinary(sandbox, "large.png", { as: "bytes" });
  assert.ok(original.kind === "bytes");
  assert.deepEqual(original.data, data);
  assert.deepEqual(await readFile(path.join(vault, "large.png")), data);
});

test("image previews apply orientation without enlarging a small image", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  const data = await sharp({ create: { width: 320, height: 180, channels: 3, background: "red" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  await writeFile(path.join(vault, "rotated.jpg"), data);
  const result = await readVaultBinary(sandbox, "rotated.jpg");
  assert.ok(result.kind === "image");
  assert.equal(result.width, 180);
  assert.equal(result.height, 320);
});

test("animated image previews identify their first-frame-only delivery", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  const single = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).gif().toBuffer();
  const flags = single[10]!;
  const headerLength = 13 + ((flags & 0x80) ? 3 * (2 ** ((flags & 7) + 1)) : 0);
  const frame = single.subarray(headerLength, -1);
  const animated = Buffer.concat([single.subarray(0, headerLength), frame, frame, Buffer.from([0x3b])]);
  assert.equal((await sharp(animated).metadata()).pages, 2);
  await writeFile(path.join(vault, "animated.gif"), animated);
  const result = await readVaultBinary(sandbox, "animated.gif");
  assert.ok(result.kind === "image");
  assert.equal(result.firstFrameOnly, true);
  assert.equal(result.height, 8);
});

test("images above the pixel guard fall back without returning oversized image content", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  // A compressed uniform image gives a valid pixel-limit fixture without a large file.
  const data = await sharp({ create: { width: 8001, height: 5000, channels: 3, background: "white" } }).png().toBuffer();
  await writeFile(path.join(vault, "pixel-limit.png"), data);
  const result = await readVaultBinary(sandbox, "pixel-limit.png");
  assert.ok(result.kind === "link");
  assert.equal(result.reason, "image_preview_unavailable");
  assert.equal(result.version, computeContentVersion(data));
});

test("the explicit byte bound is inclusive; raw bytes never silently select a link", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  await writeFile(path.join(vault, "payload.bin"), Buffer.alloc(MAX_BINARY_BYTES));
  assert.equal((await readVaultBinary(sandbox, "payload.bin", { as: "bytes" })).kind, "bytes");
  await writeFile(path.join(vault, "payload.bin"), Buffer.alloc(MAX_BINARY_BYTES + 1));
  await assert.rejects(readVaultBinary(sandbox, "payload.bin", { as: "bytes" }), VaultDocumentTooLargeError);
});

test("large file links inspect a readable file without buffering it or inventing a content version", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  const file = await open(path.join(vault, "large.bin"), "w");
  try { await file.truncate(128 * 1024 * 1024); } finally { await file.close(); }
  for (const as of ["auto", "link"] as const) {
    const result = await readVaultBinary(sandbox, "large.bin", { as });
    assert.ok(result.kind === "link");
    assert.equal(result.sizeBytes, 128 * 1024 * 1024);
    assert.equal(result.reason, as === "auto" ? "download" : "requested");
    assert.equal(result.version, undefined);
    assert.equal("data" in result, false);
  }
});

test("unrenderable and disguised images select an explicit fallback without decoding SVG", async t => {
  const { vault, sandbox } = await binaryFixture(t);
  for (const data of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from([137, 80, 78])]) {
    await writeFile(path.join(vault, "disguised.png"), data);
    const result = await readVaultBinary(sandbox, "disguised.png");
    assert.ok(result.kind === "link");
    assert.equal(result.reason, "image_preview_unavailable");
    assert.equal(result.version, computeContentVersion(data));
  }
});

test("every binary mode shares protected, traversal, symlink and regular-file safeguards", async t => {
  const { root, vault, sandbox } = await binaryFixture(t);
  await mkdir(path.join(vault, ".private"));
  await writeFile(path.join(vault, ".private", "secret.bin"), Buffer.from([0]));
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.bin"), Buffer.from([0]));
  await symlink(outside, path.join(vault, "alias"), process.platform === "win32" ? "junction" : "dir");
  for (const as of ["auto", "bytes", "link"] as const) {
    for (const input of ["../outside/secret.bin", ".private/secret.bin", "alias/secret.bin", path.join(outside, "secret.bin"),
      "../outside/secret.pdf", ".private/secret.pdf"]) {
      await assert.rejects(readVaultBinary(sandbox, input, { as }), VaultPathError);
    }
    await assert.rejects(readVaultBinary(sandbox, "missing.bin", { as }), VaultDocumentNotFoundError);
    await mkdir(path.join(vault, "directory"), { recursive: true });
    await assert.rejects(readVaultBinary(sandbox, "directory", { as }), VaultDocumentNotRegularFileError);
  }
});
