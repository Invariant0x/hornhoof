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
export type LeaseStep =
  | { do: 'take'; kind: LeaseKind; sent: Clocks; term: Term | null }
  | { do: 'fence'; why: string }
  | { do: 'renew'; kind: LeaseKind; endSessions: boolean; sent: Clocks }
  | { do: 'none' };

const secondsToATenth = (ms: number): number => Math.round(ms / 100) / 10;

/* What was sent then still stands now: either clock alone can end it, since a machine that sleeps stops only one. */
export function withinLease(sent: Clocks, now: Clocks): boolean {
  return now.wall - sent.wall < LEASE_MS && now.mono - sent.mono < LEASE_MS;
}

export function leaseValid(held: Held | null, now: Clocks): boolean {
  return held !== null && withinLease(held.sent, now);
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

type LeaseInputs = {
  now: Clocks;
  last: Clocks | null;
  held: Held | null;
  maintenance: boolean;
  split?: boolean;
  proof?: Clocks | null;
  ended?: string | null;
  entry?: { sent: Clocks; term: Term | null } | null;
};

function kindOf(o: LeaseInputs): LeaseKind {
  if (o.maintenance) return 'maintenance';
  return o.split ? 'split' : 'normal';
}

/* Left out, the entry is now under no given term. Null is another thing: nothing lets this keeper lead yet. */
function takeOnEntry(o: LeaseInputs): LeaseStep {
  const entry = o.entry === undefined ? { sent: o.now, term: null } : o.entry;
  return entry === null ? { do: 'none' } : { do: 'take', kind: kindOf(o), sent: entry.sent, term: entry.term };
}

/* A renewal promises 10 s from when its proof went out, so only a proof sent after the last renewal and still within a
   lease gives anything new. The monotonic clock says which came first, since the wall clock can be corrected between the two. */
function renewOnProof(held: Held, o: LeaseInputs): LeaseStep {
  const proof = o.proof === undefined ? o.now : o.proof;
  if (proof === null || proof.mono <= held.sent.mono || !withinLease(proof, o.now)) return { do: 'none' };
  return { do: 'renew', kind: kindOf(o), endSessions: o.maintenance && held.kind !== 'maintenance', sent: proof };
}

/* Left out, proof is now, ended null and entry { sent: now, term: null }, which is plan 3's table. */
export function nextLeaseStep(o: LeaseInputs): LeaseStep {
  if (o.held === null) return takeOnEntry(o);
  const why = o.ended ?? whyFence(o.held, o.last, o.now);
  return why === null ? renewOnProof(o.held, o) : { do: 'fence', why };
}
