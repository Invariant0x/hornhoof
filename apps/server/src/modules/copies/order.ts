import { and, asc, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines, people, personAccess, publicLinks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { queryOf } from '../merge/leader.js';
import { storeThroughput } from './measured.js';
import { SERVER_KEY } from '../nodes/nodes.js';
import { onlineShare } from '../network/join.js';
import { findThisMachine } from '../network/store.js';
import { seesAll, unfit, type Candidate } from './qualify.js';
import { afterLeave, cutReplication, leaveData, type Leaving } from './scope.js';
import { ALWAYS_SHARE, NEWCOMER_MS, placePins, scoreOf, settle, whyOf, type Measured, type Scored, type WhyContext } from './score.js';

/* The machines after the leader that hold a copy: numbers 2 and 3. */
export const COPIES = 2;
export const RANK_EVERY_MS = 60_000;

/* A machine's place. number: none for a machine that may not take the server. why: a key the card turns into words.
   data: it holds the company's data, or gets it now. clearPin: a pin ends when its machine becomes number 1. leave: it
   holds the data and its person no longer sees the whole company, so it has no place, and the data is taken from it. */
export type Ranked = { id: string; number: number | null; why: string | null; data: boolean; clearPin?: true; leave?: true };

/* The CEO's machines first, then those of people who see the whole company, then the older, then by id. */
function byOwnerThenAge(a: Candidate, b: Candidate): number {
  return Number(b.owner.isOwner) - Number(a.owner.isOwner) || Number(b.owner.company) - Number(a.owner.company) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

const measuredOf = (m: Candidate): Measured => ({
  share: m.share ?? null, linkRttMs: m.linkRttMs ?? null, linkMbps: m.linkMbps ?? null, internetRttMs: m.internetRttMs ?? null, internetMbps: m.internetMbps ?? null,
  fsyncP99Ms: m.fsyncP99Ms, memory: m.memory, cores: m.cores ?? null,
});
type Fit = Candidate & Scored;
const numbered = (m: Candidate): m is Candidate & { number: number } => typeof m.number === 'number';
const byNumber = (a: Candidate, b: Candidate): number => (a.number ?? Infinity) - (b.number ?? Infinity) || byOwnerThenAge(a, b);
/* The 95% class, then the points, then the ties: where a machine with no place yet joins. */
const byScore = (a: Fit, b: Fit): number => Number(b.always) - Number(a.always) || b.points - a.points || byOwnerThenAge(a, b);
/* From the order they had, each new one joining at the bottom by its score, and then no machine left below one it
   may pass. */
const scoredOrder = (group: Fit[]): Fit[] => settle([...group.filter(numbered).sort(byNumber), ...group.filter(m => !numbered(m)).sort(byScore)]);

/* The leader is 1, whatever it measures. The others that may take the server are those that fit and are not kept out
   by hand. A scoring orders them: the machines of three days and more before the newcomers, in each group the 95%
   class first, then by points, starting from the order they had, and two close ones do not swap. Without a scoring
   they keep their order. The places pinned by hand are then put where they were pinned. data stays as it was before
   the score: the first two after the leader, and every machine that holds a copy, so no ranking takes a copy away. */
export function rankOf(all: Candidate[], o: { leader: string; dbSize: number; link: boolean; now: Date; rescore?: boolean }): Ranked[] {
  const left = (m: Candidate): boolean => m.role === 'data' && !seesAll(m.owner);
  const others = all.filter(m => m.id !== o.leader && !left(m));
  const fits: Fit[] = others
    .filter(m => m.pin !== 'none' && unfit(m, o) === null)
    .map(m => ({ ...m, points: scoreOf(measuredOf(m)).points, always: (m.share ?? 0) >= ALWAYS_SHARE }));
  const pinOf = (m: Candidate): number | null => (/^[1-9][0-9]{0,2}$/.test(m.pin ?? '') ? Number(m.pin) : null);
  const pinned = fits.filter(m => pinOf(m) !== null);
  const rest = fits.filter(m => pinOf(m) === null);
  const newcomer = (m: Candidate): boolean => o.now.getTime() - m.createdAt.getTime() < NEWCOMER_MS;
  const order = o.rescore === false ? [...rest].sort(byNumber) : [...scoredOrder(rest.filter(m => !newcomer(m))), ...scoredOrder(rest.filter(newcomer))];
  const placed = placePins(order, pinned.map(item => ({ item, pin: pinOf(item)! })));
  /* What the line compares each with: the least memory and the best link among the machines numbered from 2. */
  const context: WhyContext = {
    leastMemory: placed.reduce<number | null>((least, m) => (m.memory !== null && (least === null || m.memory < least) ? m.memory : least), null),
    bestLink: placed.reduce<number | null>((best, m) => Math.max(best ?? 0, scoreOf(measuredOf(m)).parts.link / 20), null),
  };
  const places = new Map<string, Ranked>();
  placed.forEach((m, at) => {
    const number = at + 2;
    const data = m.role === 'data' || number <= COPIES + 1;
    const why = pinOf(m) !== null ? 'pinned' : number > COPIES + 1 ? (m.role === 'data' ? 'handing' : 'next') : newcomer(m) ? 'new' : whyOf(measuredOf(m), context);
    places.set(m.id, { id: m.id, number, why, data });
  });
  return all.map(m => {
    if (m.id === o.leader) return { id: m.id, number: 1, why: 'server', data: true, ...(m.pin ? { clearPin: true as const } : {}) };
    if (left(m)) return { id: m.id, number: null, why: null, data: false, leave: true };
    /* One that holds a copy and has no place keeps the copy until another takes its place. */
    return places.get(m.id) ?? { id: m.id, number: null, why: m.pin === 'none' ? 'out' : null, data: m.role === 'data' };
  });
}

/* The live machines with their owners, what they measure, and how much of the last week each was online. */
export async function candidates(db: Db, now = new Date()): Promise<Candidate[]> {
  const rows = await db
    .select({ machine: machines, isOwner: people.isOwner, scopeKind: people.scopeKind, status: people.status, name: people.name, personId: people.id })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(isNull(machines.revokedAt))
    .orderBy(asc(machines.createdAt), asc(machines.id));
  /* The places a person who does not see the whole company is given; none for one who is switched off. */
  const places = await db.select({ personId: personAccess.personId, n: count() }).from(personAccess).groupBy(personAccess.personId);
  const placesOf = new Map(places.map(row => [row.personId, Number(row.n)]));
  return Promise.all(
    rows.map(async ({ machine: m, ...person }) => ({
      id: m.id, kind: m.kind, networkId: m.networkId, server: m.machineKey.startsWith(SERVER_KEY), role: m.role, createdAt: m.createdAt, reportAt: m.reportAt,
      memory: m.memory, diskFree: m.diskFree, fsyncP99Ms: m.fsyncP99Ms, owes: m.uploadState !== null,
      cores: m.cores, share: await onlineShare(db, m.id, now), linkRttMs: m.linkRttMs, linkMbps: m.linkMbps, internetRttMs: m.internetRttMs, internetMbps: m.internetMbps,
      pin: m.serverPin, number: m.serverOrder,
      owner: {
        isOwner: person.isOwner, company: person.scopeKind === 'company', active: person.status === 'active', name: person.name,
        departments: person.status === 'active' ? (placesOf.get(person.personId) ?? 0) : 0,
      },
    })),
  );
}

/* Numbers the machines anew and writes only the rows whose place or role changes, all in one transaction. A machine
   that gets one of the first places gets the role data here and nothing else: its keeper sees it and makes its copy.
   Without the row of the machine this app runs on there is no leader to count from, and nothing is written. */
export async function rank(ctx: Ctx, now = new Date()): Promise<{ changed: number }> {
  const { db, config } = ctx;
  if (!(await findThisMachine(db, config))) return { changed: 0 };
  const { changed, leave } = await place(ctx, now);
  /* A machine that holds the data and whose person no longer sees the whole company, as a restore of an older backup
     can bring one back, gives the data up as it does when the scope is taken. */
  if (leave.length > 0) {
    await cutReplication(ctx.replication, leave);
    await db.transaction(tx => leaveData(ctx, tx, leave.map(machine => machine.id), now));
    await afterLeave(ctx);
  } else {
    /* A change of the link's key that the relay did not take yet is tried again with each ranking. */
    await ctx.links.finishKey().catch((err: unknown) => ctx.log.warn({ error: loggable(err) }, "Could not change the key of the company's link yet. The next minute tries again."));
  }
  return { changed };
}

async function place(ctx: Ctx, now: Date): Promise<{ changed: number; leave: Leaving[] }> {
  const { db, config } = ctx;
  return db.transaction(async tx => {
    /* A machine that left holds no number, however it left: one still on its row would keep that number from every
       machine that is there. */
    await tx.update(machines).set({ serverOrder: null, serverWhy: null }).where(and(isNotNull(machines.revokedAt), isNotNull(machines.serverOrder)));
    const before = await tx
      .select({ id: machines.id, networkId: machines.networkId, serverOrder: machines.serverOrder, serverWhy: machines.serverWhy, role: machines.role })
      .from(machines)
      .where(isNull(machines.revokedAt))
      .orderBy(asc(machines.id))
      .for('update');
    const leader = await findThisMachine(tx, config);
    if (!leader) return { changed: 0, leave: [] };
    const [sized] = await queryOf(tx)<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
    const [link] = await tx.select({ name: publicLinks.name }).from(publicLinks).limit(1);
    const places = new Map(rankOf(await candidates(tx, now), { leader: leader.id, dbSize: Number(sized?.size ?? 0), link: Boolean(link), now, rescore: true }).map(place => [place.id, place]));
    const changes = before.flatMap(row => {
      const place = places.get(row.id);
      if (!place) return [];
      const role = place.data && row.role !== 'data' ? { role: 'data' as const } : {};
      /* A pin ends when its machine becomes number 1. */
      const pin = place.clearPin ? { serverPin: null } : {};
      return place.number !== row.serverOrder || place.why !== row.serverWhy || 'role' in role || place.clearPin ? [{ id: row.id, set: { serverOrder: place.number, serverWhy: place.why, ...role, ...pin } }] : [];
    });
    const leave = before.filter(row => places.get(row.id)?.leave).map(({ id, networkId }) => ({ id, networkId }));
    if (changes.length === 0) return { changed: 0, leave };
    /* Every changed row gives its number up first, so two numbers that swap never meet. */
    await tx.update(machines).set({ serverOrder: null }).where(inArray(machines.id, changes.map(change => change.id)));
    for (const change of changes) await tx.update(machines).set(change.set).where(eq(machines.id, change.id));
    return { changed: changes.length, leave };
  });
}

/* Ranks while the app leads: at once, then every minute, and whenever asked. */
export class Ranking {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: { everyMs?: number } = {},
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.now(), this.opts.everyMs ?? RANK_EVERY_MS);
    this.timer.unref();
    this.now();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.again = false;
  }

  /* A rank as soon as the one running ends, and one more at most however often it is asked meanwhile. */
  now(): void {
    if (!this.timer) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.once().finally(() => {
      this.running = null;
      if (!this.again) return;
      this.again = false;
      this.now();
    });
  }

  /* A ranking that fails is one line, and the next minute tries again. */
  private async once(): Promise<void> {
    /* How fast the leader sends to each machine, as its keeper last said; without it the ranking goes on with what
       the rows hold. */
    await storeThroughput(this.ctx).catch((err: unknown) => this.ctx.log.warn({ error: loggable(err) }, "Could not write how fast the server sends to each machine. The rows keep what they had."));
    try {
      await rank(this.ctx);
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err) }, 'Could not number the machines that may hold the data. The next minute tries again.');
    }
  }
}
