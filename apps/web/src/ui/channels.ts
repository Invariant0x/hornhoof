import { useCallback, useEffect, useMemo, useState } from 'react';

/* How long a way a message went keeps running after the last one: a glance later shows where work went quiet. */
export const CHANNEL_MS = 10 * 60_000;

/* held: the server keeps the way on past CHANNEL_MS while the work it brought goes on. */
export type Way<T> = { key: string; at: string; value: T; held?: boolean };

/* The ways messages went in the last CHANNEL_MS, newest time each: what the server remembered when the page loaded, and
   every message heard since. Ways the server holds stay on for as long as its latest word holds them. */
export function useChannels<T>(seed: Way<T>[]): { live: T[]; touch(key: string, value: T): void } {
  const [ways, setWays] = useState(() => new Map<string, { at: number; value: T }>());
  const [now, setNow] = useState(() => Date.now());

  const seeded = useMemo(() => seed.map(w => [w.key, Date.parse(w.at), w.value] as const), [seed]);
  const held = useMemo(() => new Set(seed.filter(w => w.held).map(w => w.key)), [seed]);
  useEffect(() => {
    setWays(old => {
      const next = new Map(old);
      for (const [key, at, value] of seeded) if (!((next.get(key)?.at ?? 0) >= at)) next.set(key, { at, value });
      return next;
    });
  }, [seeded]);

  /* Wakes when the next way goes quiet, counted from the clock: the ways change on every fetch, not only on a message. */
  useEffect(() => {
    const ends = [...ways.values()].map(w => w.at + CHANNEL_MS).filter(end => end > now);
    if (!ends.length) return;
    const id = setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(...ends) - Date.now()) + 1);
    return () => clearTimeout(id);
  }, [ways, now]);

  const touch = useCallback((key: string, value: T) => {
    const at = Date.now();
    setNow(at);
    setWays(old => new Map(old).set(key, { at, value }));
  }, []);

  const live = useMemo(() => [...ways].filter(([key, w]) => now - w.at < CHANNEL_MS || held.has(key)).map(([, w]) => w.value), [ways, now, held]);
  return { live, touch };
}
