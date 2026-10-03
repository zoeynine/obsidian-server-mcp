// Shared by all stores in this process. Keys include the physical Vault root;
// spelling aliases serialize together even on a case-sensitive filesystem.
const tails = new Map<string, Promise<void>>();

/** Canonical ordering prevents source/destination lock inversions on moves. */
export async function withPathLocks<T>(root: string, paths: readonly string[], operation: () => Promise<T>): Promise<T> {
  const names = [...new Map(paths.map(name => [name.normalize("NFC").toLowerCase(), name])).entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, name]) => name);
  const acquire = (index: number): Promise<T> => index === names.length ? operation() :
    withPathLock(root, names[index]!, () => acquire(index + 1));
  return acquire(0);
}

export async function withPathLock<T>(root: string, relative: string, operation: () => Promise<T>): Promise<T> {
  const key = `${root.normalize("NFC").toLowerCase()}\0${relative.normalize("NFC").toLowerCase()}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  tails.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
