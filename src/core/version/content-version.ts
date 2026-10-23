import { createHash } from "node:crypto";

const contentVersionBrand: unique symbol = Symbol("ContentVersion");
const contentVersionPattern = /^sha256:[0-9a-f]{64}$/u;
const versionGuardBrand: unique symbol = Symbol("VersionGuard");
const versionGuardPattern = /^[0-9a-f]{16}$/u;

export type ContentVersion = string & {
  readonly [contentVersionBrand]: true;
};

/** A 64-bit convenience precondition, not a full-strength content identity. */
export type VersionGuard = string & { readonly [versionGuardBrand]: true };
export interface VersionPreconditionInput {
  readonly ifMatch?: string;
  readonly ifMatchGuard?: string;
}
export type VersionPrecondition =
  | { readonly kind: "version"; readonly value: ContentVersion }
  | { readonly kind: "guard"; readonly value: VersionGuard };

export class InvalidVersionGuardError extends Error {
  constructor(readonly value: string) {
    super("Version guard must contain exactly 16 lowercase hex characters");
    this.name = "InvalidVersionGuardError";
  }
}

export class VersionGuardConflictError extends Error {
  constructor(readonly expected: VersionGuard, readonly actual: VersionGuard) {
    super("Content version guard does not match ifMatchGuard");
    this.name = "VersionGuardConflictError";
  }
}

export class ConflictingVersionPreconditionsError extends Error {
  constructor() {
    super("Supply only one of ifMatch or ifMatchGuard, never both");
    this.name = "ConflictingVersionPreconditionsError";
  }
}

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

/** Derive from the same exact-byte SHA-256 observation; no extra read or state. */
export function getVersionGuard(version: ContentVersion): VersionGuard {
  return parseContentVersion(version).slice(7, 23) as VersionGuard;
}

export function parseVersionGuard(value: string): VersionGuard {
  if (typeof value !== "string" || value.length !== 16 || !versionGuardPattern.test(value)) {
    throw new InvalidVersionGuardError(value);
  }
  return value as VersionGuard;
}

/** Capture caller-owned options before any await; dual inputs always fail. */
export function parseVersionPrecondition(input: VersionPreconditionInput): VersionPrecondition | undefined {
  const { ifMatch, ifMatchGuard } = input;
  if (ifMatch !== undefined && ifMatchGuard !== undefined) throw new ConflictingVersionPreconditionsError();
  if (ifMatch !== undefined) return { kind: "version", value: parseContentVersion(ifMatch) };
  if (ifMatchGuard !== undefined) return { kind: "guard", value: parseVersionGuard(ifMatchGuard) };
  return undefined;
}

/** After this initial check, pin `actual` in full for all in-flight rechecks. */
export function assertVersionPrecondition(actual: ContentVersion, precondition: VersionPrecondition): void {
  if (precondition.kind === "version") return assertVersionMatch(actual, precondition.value);
  const guard = getVersionGuard(actual);
  if (guard !== precondition.value) throw new VersionGuardConflictError(precondition.value, guard);
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

