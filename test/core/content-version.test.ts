import * as assert from "node:assert/strict";
import test from "node:test";

import {
  InvalidContentVersionError,
  VersionConflictError,
  assertVersionMatch,
  computeContentVersion,
  parseContentVersion,
} from "../../src/core/version/content-version.js";

test("computes a stable SHA-256 version from exact bytes", () => {
  const version = computeContentVersion("hello");

  assert.equal(
    version,
    "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assert.equal(computeContentVersion(Buffer.from("hello", "utf8")), version);
  assert.notEqual(computeContentVersion("hello\n"), version);
});

test("accepts only canonical content-version tokens", () => {
  const version = computeContentVersion("note");

  assert.equal(parseContentVersion(version), version);
  assert.throws(
    () => parseContentVersion(version.toUpperCase()),
    InvalidContentVersionError,
  );
  assert.throws(() => parseContentVersion("sha256:abc"), InvalidContentVersionError);
});

test("enforces optimistic concurrency through ifMatch", () => {
  const actual = computeContentVersion("current");
  const stale = computeContentVersion("stale");

  assert.doesNotThrow(() => assertVersionMatch(actual, actual));
  assert.throws(
    () => assertVersionMatch(actual, stale),
    (error: unknown) =>
      error instanceof VersionConflictError &&
      error.actual === actual &&
      error.expected === stale,
  );
});

