import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { certificates, machines } from '../../db/schema.js';
import { ApiError, loggable } from '../../errors.js';
import { dropPeerSecrets, visitorKeyOf } from '../network/join.js';
import { findThisMachine } from '../network/store.js';
import { slotPrefix, type Replication } from './slots.js';

export const CUT_TRIES_MS = 5_000;
const CUT_PAUSE_MS = 50;

export type Leaving = { id: string; networkId: string | null };

const leaderScope = (hostname: string) => new ApiError(409, 'conflict', `${hostname || 'This machine'} runs the company server. Move the server to another machine first.`, 'leader_scope');
const tryAgain = () => new ApiError(503, 'unavailable', 'Try again in a minute.', 'try_again');

/* The person's machines that hold the company's data. The machine that leads cannot give its data up: the server moves
   to another machine first. */
export async function leavingData(db: Db, config: Config, personId: string): Promise<Leaving[]> {
  const rows = await db
    .select({ id: machines.id, networkId: machines.networkId, hostname: machines.hostname })
    .from(machines)
    .where(and(eq(machines.personId, personId), eq(machines.role, 'data'), isNull(machines.revokedAt)));
  const leader = rows.length > 0 ? await findThisMachine(db, config) : null;
  const leads = rows.find(row => row.id === leader?.id);
  if (leads) throw leaderScope(leads.hostname);
  return rows.map(({ id, networkId }) => ({ id, networkId }));
}

/* Cuts these machines from the leader's changes before anything new is written: the connection that reads each of
   their slots is ended and the slot dropped, so no row written from here on, a new key above all, reaches them. A copy
   may connect again between the two, so it is tried for a while; a slot that will not go leaves everything as it was. */
export async function cutReplication(replication: Replication, leaving: { networkId: string | null }[], opts: { triesMs?: number } = {}): Promise<void> {
  const prefixes = leaving.flatMap(machine => (machine.networkId ? [slotPrefix(machine.networkId)] : []));
  if (prefixes.length === 0) return;
  const until = performance.now() + (opts.triesMs ?? CUT_TRIES_MS);
  for (;;) {
    const theirs = (await replication.slots()).filter(slot => prefixes.some(prefix => slot.name.startsWith(prefix)));
    if (theirs.length === 0) return;
    if (performance.now() >= until) throw tryAgain();
    for (const slot of theirs) {
      if (slot.pid !== null) await replication.end(slot.pid);
      /* Still read, or read again already: the next round ends its reader once more. */
      await replication.drop(slot.name).catch(() => undefined);
    }
    await sleep(CUT_PAUSE_MS);
  }
}

/* The rows of machines that stop holding the data, in the transaction that takes their person's scope: no place, a
   worker's role, the upload of what they hold owed, their certificates revoked, and the secrets they knew made anew:
   those of the peer services at once, the link's key started here and finished after the commit. lost false: a copy
   the ranking handed to another machine. Its owner still sees the whole company, so it keeps its place in the order
   and no key changes: it gets a worker's role, owes what it holds, and its certificates are revoked, nothing else. */
export async function leaveData(ctx: Ctx, tx: Db, machineIds: string[], now: Date, opts: { lost?: boolean } = {}): Promise<void> {
  if (machineIds.length === 0) return;
  const lost = opts.lost ?? true;
  await tx.update(machines).set({ role: 'worker', uploadState: 'waiting', ...(lost ? { serverOrder: null, serverWhy: null, dataLeftAt: now } : {}) }).where(inArray(machines.id, machineIds));
  await tx.update(certificates).set({ revokedAt: now }).where(and(inArray(certificates.machineId, machineIds), isNull(certificates.revokedAt)));
  if (!lost) return;
  await dropPeerSecrets(tx);
  await ctx.links.startKey(tx);
}

/* After that commit: the link's key changed at the relay, a new visitor key, and the places given anew. Each is tried
   again by the ranking or the next view, so a failure here is one line. */
export async function afterLeave(ctx: Ctx): Promise<void> {
  try {
    await ctx.links.finishKey();
  } catch (err) {
    ctx.log.warn({ error: loggable(err) }, "Could not change the key of the company's link yet. The next minute tries again.");
  }
  await visitorKeyOf(ctx, { force: true });
  /* A machine left, so the order is scored anew; a run that fails says so itself and the next minute scores. */
  void ctx.ranking.now({ rescore: true }).catch(() => undefined);
}
