import { createHash } from "node:crypto";

const contentVersionBrand: unique symbol = Symbol("ContentVersion");
const contentVersionPattern = /^sha256:[0-9a-f]{64}$/u;

export type ContentVersion = string & {
  readonly [contentVersionBrand]: true;
};

export class InvalidContentVersionError extends Error {
  readonly value: string;

  constructor(value: string) {
    super("Content version must use the form sha256:<64 lowercase hex characters>");
    this.name = "InvalidContentVersionError";
    this.value = value;
  }
}

export class VersionConflictError extends Error {
  readonly actual: ContentVersion;
  readonly expected: ContentVersion;

  constructor(expected: ContentVersion, actual: ContentVersion) {
    super("Content version does not match ifMatch");
    this.name = "VersionConflictError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** Produces a deterministic version from the exact file bytes. */
export function computeContentVersion(
  content: string | Uint8Array,
): ContentVersion {
  const hash = createHash("sha256").update(content).digest("hex");
  return `sha256:${hash}` as ContentVersion;
}

/** Validates an untrusted version token received at an API boundary. */
export function parseContentVersion(value: string): ContentVersion {
  if (!contentVersionPattern.test(value)) {
    throw new InvalidContentVersionError(value);
  }

  return value as ContentVersion;
}

/** Throws a typed conflict when an ifMatch token is stale. */
export function assertVersionMatch(
  actual: ContentVersion,
  ifMatch: string,
): asserts ifMatch is ContentVersion {
  const expected = parseContentVersion(ifMatch);

  if (actual !== expected) {
    throw new VersionConflictError(expected, actual);
  }
}

