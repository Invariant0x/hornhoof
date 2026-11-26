/* How long the page waits before it looks again at a server that does not answer: the wait grows to the cap by the number of
   tries so far, and starts over once the server answers. The connection's own looks and the page's first asks both use it. */
const ASK_AGAIN_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export const askAgainAfter = (tries: number): number => ASK_AGAIN_MS[Math.min(Math.max(tries, 0), ASK_AGAIN_MS.length - 1)]!;
