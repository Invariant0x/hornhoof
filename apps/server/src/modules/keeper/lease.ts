import type { LeaseKind, Term } from '../../db/net.js';

export const LEASE_MS = 10_000;
/* A gap over this between two ticks, on either clock, is a tick more than 5 s late. */
export const LATE_MS = 6_000;
/* The wall clock going back more than this. A smaller step is the clock being corrected, and a tick survives it. */
export const BACK_MS = 1_000;

/* Date.now() and performance.now(). Both are kept because a machine that sleeps stops one and not the other. */
export type Clocks = { wall: number; mono: number };
/* The last renewal that committed, by when it was sent, since a renewal cannot promise more than its send time allows. */
export type Held = { term: Term; kind: LeaseKind; sent: Clocks };
export type LeaseStep = { do: 'take'; kind: LeaseKind } | { do: 'fence'; why: string } | { do: 'renew'; kind: LeaseKind; endSessions: boolean };

const secondsToATenth = (ms: number): number => Math.round(ms / 100) / 10;

export function leaseValid(held: Held | null, now: Clocks): boolean {
  if (held === null) return false;
  return now.wall - held.sent.wall < LEASE_MS && now.mono - held.sent.mono < LEASE_MS;
}

function whyTickIsLate(last: Clocks, now: Clocks): string | null {
  const gap = Math.max(now.mono - last.mono, now.wall - last.wall);
  if (gap > LATE_MS) return `a tick came ${secondsToATenth(gap)} s after the one before`;
  const back = last.wall - now.wall;
  if (back > BACK_MS) return `the clock went back ${secondsToATenth(back)} s`;
  return null;
}

/* A late tick goes first: it fences a lease that still looks valid, and it names what happened when the lease lapsed too. */
function whyFence(held: Held, last: Clocks | null, now: Clocks): string | null {
  const late = last === null ? null : whyTickIsLate(last, now);
  if (late !== null) return late;
  return leaseValid(held, now) ? null : `no renewal for ${secondsToATenth(LEASE_MS)} s`;
}

export function nextLeaseStep(o: { now: Clocks; last: Clocks | null; held: Held | null; maintenance: boolean }): LeaseStep {
  const kind: LeaseKind = o.maintenance ? 'maintenance' : 'normal';
  if (o.held === null) return { do: 'take', kind };
  const why = whyFence(o.held, o.last, o.now);
  if (why !== null) return { do: 'fence', why };
  return { do: 'renew', kind, endSessions: o.maintenance && o.held.kind !== 'maintenance' };
}
