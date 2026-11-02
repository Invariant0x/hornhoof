import { lineState, yellowUntil, type LineFacts, type LineState, type WorkLine } from '@hornhoof/protocol/map';
import { useEffect, useMemo, useState } from 'react';

const keyOf = (upstreamAgentId: string, downstreamAgentId: string) => `${upstreamAgentId}>${downstreamAgentId}`;

/* The state of each line of work, by its two ends: blue while the work goes on, yellow for five minutes after a result came
   back, quiet otherwise. The server times it: serverNow is its clock when it read the lines, so a wrong clock on this
   computer moves nothing, and a page opened two minutes after a result burns the three that are left. */
export function useWorkLines(lines: readonly WorkLine[] | undefined, serverNow: string | undefined): (upstreamAgentId: string, downstreamAgentId: string) => LineState {
  /* How far the server's clock is from this one, taken when its answer came. */
  const skew = useMemo(() => (serverNow ? Date.parse(serverNow) - Date.now() : 0), [serverNow]);
  const facts = useMemo(
    () =>
      new Map<string, LineFacts>(
        (lines ?? []).map(l => [
          keyOf(l.upstreamAgentId, l.downstreamAgentId),
          { working: l.working, workEpoch: l.workEpoch, returnedEpoch: l.returnedEpoch, returnedAt: l.returnedAt === null ? null : Date.parse(l.returnedAt) },
        ]),
      ),
    [lines],
  );
  /* The page draws again when the next yellow line goes out. */
  const [tick, setTick] = useState(0);
  const now = Date.now() + skew;
  const next = Math.min(...[...facts.values()].map(f => yellowUntil(f) ?? Infinity).filter(until => until > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const id = setTimeout(() => setTick(n => n + 1), Math.max(0, next - (Date.now() + skew)));
    return () => clearTimeout(id);
  }, [next, skew, tick]);
  const states = new Map([...facts].map(([key, f]) => [key, lineState(f, now)]));
  return (upstreamAgentId, downstreamAgentId) => states.get(keyOf(upstreamAgentId, downstreamAgentId)) ?? 'quiet';
}
