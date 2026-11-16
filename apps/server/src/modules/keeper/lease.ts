import type { LeaseKind, Term } from '../../db/net.js';

export const LEASE_MS = 10_000;
/* A gap over this between two ticks, on either clock, is a tick more than 5 s late: on a disk that writes quickly. */
export const LATE_MS = 6_000;
/* How long one of the keeper's statements may take, on a disk that writes quickly. */
export const QUERY_MS = 2_000;
/* Half a lease: a renewal that cannot commit in that time leaves room for one more before the lease runs out. */
export const QUERY_MAX_MS = LEASE_MS / 2;
/* A second short of a lease, the pause between two ticks: a tick that comes later could not have renewed in time. */
export const LATE_MAX_MS = LEASE_MS - 1_000;
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
const within = (ms: number, low: number, high: number): number => Math.min(Math.max(ms, low), high);
const measured = (fsyncP99Ms: number | null): number => (fsyncP99Ms !== null && Number.isFinite(fsyncP99Ms) && fsyncP99Ms > 0 ? fsyncP99Ms : 0);

/* What one of the keeper's statements may take on a disk whose fsync p99 was measured: a renewal commits once, and
   waits for its own fsync and at worst for one under way before it. Never less than on a quick disk, never more than
   half a lease. None measured yet counts as a quick disk. */
export function queryTimeoutMs(fsyncP99Ms: number | null): number {
  return within(2 * measured(fsyncP99Ms), QUERY_MS, QUERY_MAX_MS);
}

/* How late a tick may come on that disk: the keeper's statements go one after another on one connection, so a tick
   may wait for one ahead of its renewal, a new connection after that one gave up, and the renewal itself. Three
   statements at their time, which is the old 6 s on a quick disk, and never a whole lease. */
export function lateTickMs(fsyncP99Ms: number | null): number {
  return within(3 * queryTimeoutMs(fsyncP99Ms), LATE_MS, LATE_MAX_MS);
}

/* What was sent then still stands now: either clock alone can end it, since a machine that sleeps stops only one. */
export function withinLease(sent: Clocks, now: Clocks): boolean {
  return now.wall - sent.wall < LEASE_MS && now.mono - sent.mono < LEASE_MS;
}

export function leaseValid(held: Held | null, now: Clocks): boolean {
  return held !== null && withinLease(held.sent, now);
}

function whyTickIsLate(last: Clocks, now: Clocks, lateMs: number): string | null {
  const gap = Math.max(now.mono - last.mono, now.wall - last.wall);
  if (gap > lateMs) return `a tick came ${secondsToATenth(gap)} s after the one before`;
  const back = last.wall - now.wall;
  if (back > BACK_MS) return `the clock went back ${secondsToATenth(back)} s`;
  return null;
}

/* A late tick goes first: it fences a lease that still looks valid, and it names what happened when the lease lapsed too. */
function whyFence(held: Held, last: Clocks | null, now: Clocks, lateMs: number): string | null {
  const late = last === null ? null : whyTickIsLate(last, now, lateMs);
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
  /* How late a tick may come: LATE_MS when left out, and no limit at all where no other machine could lead, as no stall
     here can make two leaders then. */
  lateMs?: number;
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
  const why = o.ended ?? whyFence(o.held, o.last, o.now, o.lateMs ?? LATE_MS);
  return why === null ? renewOnProof(o.held, o) : { do: 'fence', why };
}
