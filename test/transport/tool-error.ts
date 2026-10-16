import * as assert from "node:assert/strict";

interface ToolResult {
  readonly isError?: boolean | undefined;
  readonly content: readonly { readonly type: string; readonly text?: string | undefined }[];
}

export interface ToolErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function readToolErrorPayload(result: ToolResult): ToolErrorPayload {
  assert.equal(result.isError, true);
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block?.type === "text" && typeof block.text === "string");
  const payload = JSON.parse(block.text) as ToolErrorPayload;
  assert.equal(typeof payload.error.code, "string");
  assert.equal(typeof payload.error.message, "string");
  return payload;
}

export function readToolError(result: ToolResult): ToolErrorPayload["error"] {
  return readToolErrorPayload(result).error;
}
