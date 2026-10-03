import { link, rename, unlink, type FileHandle } from "node:fs/promises";

/** Small trusted I/O seam for deterministic failure/race fixtures. Publication
 * must be atomic, with no destination unlink, copy fallback, or retry.
 */
export interface MutationIO {
  writeFile(handle: FileHandle, bytes: Uint8Array): Promise<void>;
  syncFile(handle: FileHandle): Promise<void>;
  closeFile(handle: FileHandle): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  link(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nativeMutationIO: MutationIO = Object.freeze({
  writeFile: async (handle: FileHandle, bytes: Uint8Array) => { await handle.writeFile(bytes); },
  syncFile: async (handle: FileHandle) => { await handle.sync(); },
  closeFile: async (handle: FileHandle) => { await handle.close(); },
  rename,
  // Node rename has no NOREPLACE flag. Hard-link publication refuses a file
  // that appears concurrently; cleanup then removes the hidden temporary name.
  link,
  unlink,
});
