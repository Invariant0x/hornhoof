import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines, publicLinks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { builtinMachine } from '../nodes/nodes.js';
import { findThisMachine } from '../network/store.js';
import { candidates, rankOf, readyCopies } from './order.js';
import { unfit } from './qualify.js';

/* Where the CEO puts a machine in the server order by hand: null leaves it to the score, 'none' keeps it from the
   server, a number is its place, from 2. */
export type Pin = null | 'none' | number;

const leaderPin = () => new ApiError(409, 'conflict', 'Move the server to another machine first.', 'leader_pin');
const onlyCopy = (hostname: string) => new ApiError(409, 'conflict', `${hostname || 'This machine'} holds the only up-to-date copy; give another machine a place first.`, 'only_copy');
const cannotTake = () => new ApiError(400, 'validation', 'This machine cannot take the server.', 'unfit');
const tryAgain = () => new ApiError(503, 'unavailable', 'Try again in a minute.', 'try_again');

/* Stores the CEO's choice for one live machine, then ranks with a scoring and the CEO's mark, and ends when that run
   ended. The machine that leads takes no pin: the server moves first. The only copy that is up to date is not kept
   from the server. A place goes to a machine that may take the server, and is one of those there are once the change
   is made; a place another machine had by hand is taken from it. A ranking that fails leaves the pin stored, and the
   next run places it. */
export async function setPriority(ctx: Ctx, machineId: string, pin: Pin): Promise<void> {
  const { db, config } = ctx;
  const now = new Date();
  const [row] = await db.select().from(machines).where(and(eq(machines.id, machineId), isNull(machines.revokedAt)));
  if (!row) throw new ApiError(404, 'not_found', 'This machine does not exist.', 'machine_unknown');
  const leader = await findThisMachine(db, config);
  const host = await builtinMachine(db, config.hostId, row.companyId, config.machineId);
  if (row.id === leader?.id || row.id === host?.id) throw leaderPin();

  if (pin === 'none' && row.role === 'data') {
    const holding = await db.select({ id: machines.id, copyName: machines.copyName }).from(machines).where(and(eq(machines.role, 'data'), isNull(machines.revokedAt)));
    const { ready } = readyCopies(ctx, holding, now);
    if (ready.has(row.id) && ready.size === 1) throw onlyCopy(row.hostname);
  }
  if (typeof pin === 'number') {
    const [link] = await db.select(only(publicLinks, 'name')).from(publicLinks).limit(1);
    const fit = { link: Boolean(link) };
    const all = await candidates(db, now);
    const mine = all.find(m => m.id === row.id);
    if (!mine || unfit(mine, fit) !== null) throw cannotTake();
    /* The places there are with this change made, the leader's included: a machine coming back takes the last. */
    const changed = all.map(m => (m.id === row.id ? { ...m, pin: String(pin) } : m));
    const places = 1 + rankOf(changed, { leader: leader?.id ?? '', ...fit, now, rescore: false }).filter(one => one.id !== leader?.id && one.number !== null).length;
    if (pin < 2 || pin > places) throw new ApiError(400, 'validation', places < 2 ? 'There is no place to give yet.' : `Choose a place from 2 to ${places}.`);
  }

  const stored = pin === null ? null : String(pin);
  await db.transaction(async tx => {
    await tx.select(idOnly(machines)).from(machines).where(isNull(machines.revokedAt)).orderBy(asc(machines.id)).for('update');
    if (typeof pin === 'number') await tx.update(machines).set({ serverPin: null }).where(and(eq(machines.serverPin, String(pin)), ne(machines.id, row.id)));
    await tx.update(machines).set({ serverPin: stored }).where(eq(machines.id, row.id));
  });
  try {
    await ctx.ranking.now({ rescore: true, ceo: true });
  } catch {
    throw tryAgain();
  }
}
