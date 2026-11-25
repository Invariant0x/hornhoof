/* What a copy of the company's data asks of the path the leader sends it over, as the leader measures it: the rate it
   sends to the machine at its best, and the round trip of the machine's hellos to the leader. A path that is measured
   and under this is no path for a copy: its table copies break on the way, each time again, and hold a slot and a
   snapshot of the leader meanwhile. A path nothing was measured on is not called weak: it is tried. */

/* The least rate, in megabits a second, a copy is made at, whatever its size. */
export const MIN_COPY_MBPS = 2;
/* The longest the first copy of the whole database may take at the rate measured. */
export const COPY_HOURS = 6;
/* The longest round trip, in milliseconds, a copy's stream keeps up with: its sender ends a connection that does not
   answer in a minute, and a round trip of this size leaves it too little of that. */
export const MAX_COPY_RTT_MS = 1500;

/* slow: the rate is under the least, or the database would take longer than that to go over at it. late: the round trip
   is longer than a copy's stream keeps up with. */
export type Weakness = 'slow' | 'late';

export function weakPath(path: { linkMbps?: number | null; linkRttMs?: number | null }, databaseBytes: number | null): Weakness | null {
  const mbps = path.linkMbps ?? null;
  const rtt = path.linkRttMs ?? null;
  if (rtt !== null && rtt > MAX_COPY_RTT_MS) return 'late';
  if (mbps === null) return null;
  if (mbps < MIN_COPY_MBPS) return 'slow';
  if (databaseBytes !== null && databaseBytes * 8 > mbps * 1e6 * COPY_HOURS * 3600) return 'slow';
  return null;
}
