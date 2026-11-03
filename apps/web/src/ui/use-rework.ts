import { REWORK_MS } from '@hornhoof/protocol/map';
import { useEffect, useMemo, useState } from 'react';

/* Time since the actual event on the server's clock, carried forward by this page's steady clock. */
export function useRework(at: string | null | undefined, serverNow: string | undefined): boolean {
  const anchor = useMemo(() => ({ server: serverNow ? Date.parse(serverNow) : Date.now(), steady: performance.now() }), [serverNow]);
  const [tick, setTick] = useState(0);
  const start = Date.parse(at ?? '');
  const until = start + REWORK_MS;
  const now = anchor.server + performance.now() - anchor.steady;
  useEffect(() => {
    const remaining = until - (anchor.server + performance.now() - anchor.steady);
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setTick(n => n + 1), remaining);
    return () => clearTimeout(timer);
  }, [until, anchor, tick]);
  return start <= now && now < until;
}
