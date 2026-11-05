/* One thing at a time per key: each call starts once the ones before it under the key ended, whichever way, and a key
   with nothing left in its lane is forgotten. */
export function inLane<T>(lanes: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
  const run = (lanes.get(key) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  lanes.set(key, settled);
  void settled.then(() => {
    if (lanes.get(key) === settled) lanes.delete(key);
  });
  return run;
}
