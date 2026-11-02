import { lineState, yellowUntil, type LineFacts, type LineState, type WorkLine } from '@hornhoof/protocol/map';
import { useEffect, useMemo, useState } from 'react';

const keyOf = (upstreamAgentId: string, downstreamAgentId: string) => `${upstreamAgentId}>${downstreamAgentId}`;

/* The server's clock when its answer came, and this page's steady clock at that moment. */
type Anchor = { server: number; steady: number };

/* The time on the server's clock now: its answer, and what passed since by the page's steady clock, which a change of this
   computer's clock does not move. */
const serverClock = (a: Anchor) => a.server + (performance.now() - a.steady);

/* The state of each line of work, by its two ends: blue while the work goes on, yellow for five minutes after a result came
   back, quiet otherwise. The server times it: serverNow is its clock when it read the lines, so a wrong clock on this
   computer, or one put forward or back while the page is open, moves nothing, and a page opened two minutes after a
   result burns the three that are left. */
export function useWorkLines(lines: readonly WorkLine[] | undefined, serverNow: string | undefined): (upstreamAgentId: string, downstreamAgentId: string) => LineState {
  const anchor = useMemo<Anchor>(() => ({ server: serverNow ? Date.parse(serverNow) : Date.now(), steady: performance.now() }), [serverNow]);
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
  const now = serverClock(anchor);
  const next = Math.min(...[...facts.values()].map(f => yellowUntil(f) ?? Infinity).filter(until => until > now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const id = setTimeout(() => setTick(n => n + 1), Math.max(0, next - serverClock(anchor)));
    return () => clearTimeout(id);
  }, [next, anchor, tick]);
  const states = new Map([...facts].map(([key, f]) => [key, lineState(f, now)]));
  return (upstreamAgentId, downstreamAgentId) => states.get(keyOf(upstreamAgentId, downstreamAgentId)) ?? 'quiet';
}
