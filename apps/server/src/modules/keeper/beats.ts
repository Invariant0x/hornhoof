import { z } from 'zod';
import type { LeaseKind, Term } from '../../db/net.js';
import type { Clocks } from './lease.js';

export const BEAT_MS = 1_000;
export const BEAT_WAIT_MS = 900;

const TermShape: z.ZodType<Term> = z.object({ number: z.number().int().nonnegative(), machine: z.string().min(1), split: z.boolean() });
const LeaseKindShape: z.ZodType<LeaseKind> = z.enum(['normal', 'split', 'maintenance']);

/* lead: sync is the network id the relay's record names "on" at the keeper's current generation, else null; until the
   lease's end, wall ms. follow: the term followed, "not attempting". handing: plan 9c's target's network id. idle: a
   leading keeper without a lease, with its own state's term. */
const StanceShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lead'), term: TermShape, lease: LeaseKindShape, sync: z.string().nullable(), until: z.number() }),
  z.object({ kind: z.literal('follow'), term: TermShape.nullable() }),
  z.object({ kind: z.literal('attempting') }),
  z.object({ kind: z.literal('handing'), to: z.string() }),
  z.object({ kind: z.literal('idle'), term: TermShape.nullable() }),
]);
export type Stance = z.infer<typeof StanceShape>;

/* machine: the sender's network id. reach: ISO time. ready: its copy finished and its database never led (the leader:
   true). full: its last lease write failed for a full disk (SQLSTATE 53100). What a newer keeper adds is let by and
   dropped, since messages between keepers change only by additions and a refused beat counts as silence. */
const BeatShape = z.object({
  machine: z.string().min(1),
  host: z.string(),
  stance: StanceShape,
  number: z.number().int().nullable(),
  reach: z.string().nullable(),
  ready: z.boolean(),
  full: z.boolean(),
});
export type Beat = z.infer<typeof BeatShape>;

/* at: this keeper's monotonic ms when it came. sent: for an answer, when the beat it answers was sent. */
export type Heard = { beat: Beat; at: number; sent: Clocks | null };

export function parseBeat(body: unknown): Beat | null {
  const parsed = BeatShape.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export function parseTerm(body: unknown): Term | null {
  const parsed = TermShape.safeParse(body);
  return parsed.success ? parsed.data : null;
}
