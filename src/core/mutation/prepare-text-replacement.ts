import { assertTextContent } from "../file/text-policy.js";
import { VaultMutationError } from "./mutation-errors.js";

export const MAX_TEXT_REPLACEMENT_INPUT_BYTES = 4 * 1024 * 1024;

/** Validate primitive inputs before waiting on a mutation lock or reading a file. */
export function assertTextReplacementInput(inputPath: string, oldText: string, newText: string): void {
  if (typeof oldText !== "string" || typeof newText !== "string" || oldText.length === 0) {
    throw new VaultMutationError("invalid_replacement", "oldText must be a nonempty string and newText must be a string", { path: inputPath });
  }
  assertTextContent(inputPath, oldText);
  assertTextContent(inputPath, newText);
  if (Buffer.byteLength(oldText, "utf8") + Buffer.byteLength(newText, "utf8") > MAX_TEXT_REPLACEMENT_INPUT_BYTES) {
    throw new VaultMutationError("too_large", "Combined oldText and newText input exceeds 4 MiB", { path: inputPath });
  }
  if (oldText === newText) {
    throw new VaultMutationError("no_change", "oldText and newText must differ", { path: inputPath });
  }
}

/** Inputs are validated above; preserve every code unit outside the unique match. */
export function prepareTextReplacement(inputPath: string, content: string, oldText: string, newText: string): string {
  const first = content.indexOf(oldText);
  if (first === -1) {
    throw new VaultMutationError("text_not_found", "oldText was not found in the current document", { path: inputPath, matchCount: 0 });
  }
  // Advance one code unit, not oldText.length, so overlapping matches count.
  if (content.indexOf(oldText, first + 1) !== -1) {
    throw new VaultMutationError("ambiguous_text", "oldText matches more than once; expand oldText with surrounding original text until it matches exactly once", { path: inputPath, matchCountAtLeast: 2 });
  }
  // String.replace would interpret replacement templates such as $& and $1.
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}
