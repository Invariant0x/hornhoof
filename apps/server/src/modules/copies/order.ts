import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines, people, personAccess, publicLinks, teams } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { freshState } from '../keeper/state.js';
import { queryOf } from '../merge/leader.js';
import { storeThroughput } from './measured.js';
import { moveTargetRow } from './move.js';
import { SERVER_KEY } from '../nodes/nodes.js';
import { onlineShares } from '../network/join.js';
import { findThisMachine } from '../network/store.js';
import { REPORT_FRESH_MS, seesAll, unfit, type Candidate } from './qualify.js';
import { afterLeave, cutReplication, leaveData, type Leaving } from './scope.js';
import { ALWAYS_SHARE, NEWCOMER_MS, placePins, scoreOf, settle, whyOf, type Measured, type Scored, type WhyContext } from './score.js';

/* The machines after the leader that hold a copy: numbers 2 and 3. */
export const COPIES = 2;
export const RANK_EVERY_MS = 60_000;
export const RESCORE_EVERY_MS = 86_400_000;

/* A machine's place. number: none for a machine that may not take the server. why: a key the card turns into words.
   clearPin: a pin ends when its machine becomes number 1. leave: it holds the data and its person no longer sees the
   whole company, so it has no place, and the data is taken from it. Who holds a copy is planRoles' to say. */
export type Ranked = { id: string; number: number | null; why: string | null; clearPin?: true; leave?: true };

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
   they keep their order. The places pinned by hand are then put where they were pinned. */
export function rankOf(all: Candidate[], o: { leader: string; link: boolean; now: Date; rescore?: boolean }): Ranked[] {
  const left = (m: Candidate): boolean => m.role === 'data' && !seesAll(m.owner);
  const others = all.filter(m => m.id !== o.leader && !left(m));
  const fits: Fit[] = others
    .filter(m => mayTake(m, o))
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
    const why = pinOf(m) !== null ? 'pinned' : number > COPIES + 1 ? (m.role === 'data' ? 'handing' : 'next') : newcomer(m) ? 'new' : whyOf(measuredOf(m), context);
    places.set(m.id, { id: m.id, number, why });
  });
  return all.map(m => {
    if (m.id === o.leader) return { id: m.id, number: 1, why: 'server', ...(m.pin ? { clearPin: true as const } : {}) };
    if (left(m)) return { id: m.id, number: null, why: null, leave: true };
    return places.get(m.id) ?? { id: m.id, number: null, why: m.pin === 'none' ? 'out' : null };
  });
}

export const HANDOVER_EVERY_MS = 86_400_000;

/* grant: the machines that get the company's data now. retire: the copy that gives it up now, one a run. handover: a
   grant took no free seat, so a copy is being handed from one machine to another. */
export type Roles = { grant: string[]; retire: string | null; handover: boolean };

/* Who holds a copy after a ranking. numbered: the machines with a place from 2 on. data: the machines that hold the
   data besides the leader; out: kept from the server by hand. eligible: may get the data now: it is there, and holds
   nothing of a copy it gave up. ready: its copy is up to date; sync: the one commits wait for. The machines at 2 and 3
   are to hold the copies. A free seat is filled at once, by the first machine in the order that may get the data, so a
   machine that is away does not leave the company short of a copy; back, it takes its copy by a handover.
   With none free, a copy is handed over: the machine at 2 or 3 without one gets the data, at most one a day unless the
   CEO asked, and only while no other copy is being made. The copy that was ranked out goes only once both places hold
   an up-to-date copy, never the one commits wait for, and one that only stopped qualifying stays until a machine took
   its place. target: the machine the CEO asked the server moved to, while that request stands: when it has a number
   and may get the data now it gets it at once, beside the two copies when it is neither of them, and nothing here
   retires it; no other copy is handed over in the run that gives it the data. */
export function planRoles(o: {
  numbered: { id: string; number: number }[];
  data: { id: string; number: number | null; out: boolean }[];
  eligible: Set<string>;
  ready: Set<string>;
  sync: string | null;
  handoverAt: Date | null;
  now: Date;
  ceo: boolean;
  target?: string | null;
}): Roles {
  const holding = new Set(o.data.map(row => row.id));
  const top = o.numbered.filter(row => row.number <= COPIES + 1).sort((a, b) => a.number - b.number);
  const target = o.target != null && o.numbered.some(row => row.id === o.target) ? o.target : null;
  /* A target that is neither of the two places holds its copy beside them, and takes no seat of theirs. */
  const beside = target !== null && !top.some(row => row.id === target);
  /* Asked for or not, a machine gets the data only while it may: one that still owes what it held, or is away, waits. */
  const forced = target !== null && !holding.has(target) && o.eligible.has(target);
  const without = top.filter(row => !holding.has(row.id) && o.eligible.has(row.id)).map(row => row.id);
  const seats = COPIES - o.data.filter(row => !(beside && row.id === target)).length;
  const there = [...o.numbered]
    .sort((a, b) => a.number - b.number)
    .filter(row => !holding.has(row.id) && o.eligible.has(row.id) && !(beside && row.id === target))
    .map(row => row.id);
  const grant = seats > 0 ? there.slice(0, seats) : [];
  const made = top.filter(row => holding.has(row.id)).every(row => o.ready.has(row.id));
  const due = o.ceo || o.handoverAt === null || o.now.getTime() - o.handoverAt.getTime() >= HANDOVER_EVERY_MS;
  const handover = seats <= 0 && without.length > 0 && made && due && !forced;
  if (handover) grant.push(without[0]!);
  if (forced && !grant.includes(target)) grant.push(target);
  const settled = top.length > 0 && top.every(row => holding.has(row.id) && o.ready.has(row.id));
  const outside = o.data
    .filter(row => row.id !== target && !top.some(one => one.id === row.id) && row.id !== o.sync && (top.length >= COPIES || row.out))
    .sort((a, b) => (b.number ?? Infinity) - (a.number ?? Infinity) || (a.id < b.id ? -1 : 1));
  return { grant, retire: settled ? (outside[0]?.id ?? null) : null, handover };
}

/* The live machines with their owners, what they measure, and how much of the last week each was online; shares
   false leaves that out, for a reader that only asks whether a machine fits. */
export async function candidates(db: Db, now = new Date(), opts: { shares?: boolean } = {}): Promise<Candidate[]> {
  const rows = await db
    .select({ machine: machines, isOwner: people.isOwner, scopeKind: people.scopeKind, status: people.status, name: people.name, personId: people.id })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(isNull(machines.revokedAt))
    .orderBy(asc(machines.createdAt), asc(machines.id));
  /* The departments a person who does not see the whole company sees, each once: one given whole, or one a team of
     theirs is in. */
  const places = await db
    .select({ personId: personAccess.personId, n: sql<number>`count(DISTINCT COALESCE(${personAccess.departmentId}, ${teams.departmentId}))::int` })
    .from(personAccess)
    .leftJoin(teams, eq(teams.id, personAccess.teamId))
    .groupBy(personAccess.personId);
  const placesOf = new Map(places.map(row => [row.personId, Number(row.n)]));
  const shares = opts.shares === false ? null : await onlineShares(db, now);
  return rows.map(({ machine: m, ...person }) => ({
    id: m.id, kind: m.kind, networkId: m.networkId, server: m.machineKey.startsWith(SERVER_KEY), role: m.role, createdAt: m.createdAt, reportAt: m.reportAt,
    memory: m.memory, fsyncP99Ms: m.fsyncP99Ms, owes: m.uploadState !== null,
    cores: m.cores, share: shares?.get(m.id) ?? null, linkRttMs: m.linkRttMs, linkMbps: m.linkMbps, internetRttMs: m.internetRttMs, internetMbps: m.internetMbps,
    pin: m.serverPin, number: m.serverOrder,
    owner: {
      isOwner: person.isOwner, company: person.scopeKind === 'company', active: person.status === 'active', name: person.name,
      ...(person.status === 'active' ? { departments: placesOf.get(person.personId) ?? 0 } : {}),
    },
  }));
}

/* Whether a machine may take the server: it fits and was not kept out by hand. */
const mayTake = (m: Candidate, o: { link: boolean }): boolean => m.pin !== 'none' && unfit(m, o) === null;

type Placed = { changed: number; scored: boolean; leave: Leaving[]; retire: { id: string; networkId: string | null; copyName: string | null } | null; top: string[] };

/* The copies that are up to date, and the one commits wait for, as the keeper that leads reads them from its own
   Postgres, by machine. A word that is old or missing names none. */
export function readyCopies(ctx: Ctx, rows: { id: string; copyName: string | null }[], now: Date): { ready: Set<string>; sync: string | null } {
  const said = freshState(ctx.config.controlDir, now.getTime())?.copies ?? [];
  const stateOf = (row: { copyName: string | null }) => said.find(copy => copy.name === row.copyName)?.state ?? null;
  return {
    ready: new Set(rows.filter(row => ['sync', 'pace'].includes(stateOf(row) ?? '')).map(row => row.id)),
    sync: rows.find(row => stateOf(row) === 'sync')?.id ?? null,
  };
}

/* Numbers the machines and says who holds a copy, in one transaction, writing only the rows that change. The order is
   scored once a day, when a machine joined or left, when the leader's row is not number 1, and when the caller asks;
   any other run keeps the order and places the pins again. A machine that gets a seat gets the role data here and
   nothing else: its keeper sees it and makes its copy. After it: a machine whose person no longer sees the whole
   company gives its data up, and a copy that was ranked out is retired, once both places hold an up-to-date copy and
   commits wait for another. Without the row of the machine this app runs on there is no leader to count from, and
   nothing is written. */
export async function rank(ctx: Ctx, now = new Date(), opts: { rescore?: boolean; ceo?: boolean } = {}): Promise<{ changed: number; scored: boolean }> {
  const { db, config } = ctx;
  const own = await findThisMachine(db, config);
  if (!own) return { changed: 0, scored: false };
  await hiddenName(ctx, own.id);
  const { changed, scored, leave, retire, top } = await place(ctx, now, opts);
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
  if (retire) await retireCopy(ctx, retire, top, now);
  return { changed, scored };
}

/* The machines that keep copies and the server tell each other at hornhoof.org who holds the latest changes, under
   the company's name there. A company with no link gets a hidden name for that, which nobody but its machines ever
   uses, as soon as another machine with the company's core is there to keep a copy; a company of one machine asks
   hornhoof.org for nothing. While hornhoof.org does not answer there is none, no machine gets a copy, and the next
   ranking asks again. */
async function hiddenName(ctx: Ctx, own: string): Promise<void> {
  const { db } = ctx;
  const [link] = await db.select({ name: publicLinks.name }).from(publicLinks).limit(1);
  if (link) return;
  const [other] = await db
    .select({ companyId: machines.companyId })
    .from(machines)
    .where(and(isNull(machines.revokedAt), isNotNull(machines.networkId), ne(machines.id, own), eq(machines.kind, 'computer')))
    .limit(1);
  if (other) await ctx.links.ensureHidden(other.companyId);
}

/* Asked again right before the cut, since the keeper may have named this copy the one commits wait for meanwhile:
   only while both places still hold an up-to-date copy and the setting does not name it is it cut from the leader's
   changes and told to give up what it holds. Else it stays, and the next run looks again. */
async function retireCopy(ctx: Ctx, copy: NonNullable<Placed['retire']>, top: string[], now: Date): Promise<void> {
  const rows = await ctx.db.select({ id: machines.id, copyName: machines.copyName }).from(machines).where(inArray(machines.id, top));
  const { ready } = readyCopies(ctx, rows, new Date());
  if (!top.every(id => ready.has(id))) return;
  if (copy.copyName && (await ctx.replication.standby()).includes(copy.copyName)) return;
  await cutReplication(ctx.replication, [copy]);
  await ctx.db.transaction(tx => leaveData(ctx, tx, [copy.id], now, { lost: false }));
}

async function place(ctx: Ctx, now: Date, opts: { rescore?: boolean; ceo?: boolean }): Promise<Placed> {
  const { db, config } = ctx;
  return db.transaction(async tx => {
    /* A machine that left holds no place and no pin, however it left: one still on its row would keep that number
       from every machine that is there. */
    const cleared = await tx
      .update(machines)
      .set({ serverOrder: null, serverWhy: null, serverPin: null })
      .where(and(isNotNull(machines.revokedAt), or(isNotNull(machines.serverOrder), isNotNull(machines.serverPin))))
      .returning({ id: machines.id });
    const before = await tx
      .select({ id: machines.id, networkId: machines.networkId, serverOrder: machines.serverOrder, serverWhy: machines.serverWhy, role: machines.role, copyName: machines.copyName })
      .from(machines)
      .where(isNull(machines.revokedAt))
      .orderBy(asc(machines.id))
      .for('update');
    const leader = await findThisMachine(tx, config);
    if (!leader) return { changed: 0, scored: false, leave: [], retire: null, top: [] };
    const q = queryOf(tx);
    await q('INSERT INTO net.ranking (id) VALUES (true) ON CONFLICT (id) DO NOTHING');
    const [kept] = await q<{ rescored_at: Date | string | null; handover_at: Date | string | null }>('SELECT rescored_at, handover_at FROM net.ranking FOR UPDATE');
    const [link] = await tx.select({ name: publicLinks.name }).from(publicLinks).limit(1);
    const fit = { link: Boolean(link) };
    const all = await candidates(tx, now);
    const others = all.filter(m => m.id !== leader.id);
    /* A machine joined, left or stopped fitting, or the server moved: the order is scored whatever the day. */
    const joined = others.some(m => m.number == null && !(m.role === 'data' && !seesAll(m.owner)) && mayTake(m, fit));
    const left = others.some(m => m.number != null && !mayTake(m, fit));
    const moved = all.find(m => m.id === leader.id)?.number !== 1;
    const day = !kept?.rescored_at || now.getTime() - new Date(kept.rescored_at).getTime() >= RESCORE_EVERY_MS;
    const scored = Boolean(opts.rescore) || day || cleared.length > 0 || joined || left || moved;
    const ranked = rankOf(all, { leader: leader.id, ...fit, now, rescore: scored });
    const places = new Map(ranked.map(one => [one.id, one]));

    /* Who holds a copy: the machines at 2 and 3, by what the keeper says of the copies there are. */
    const holding = before.filter(row => row.role === 'data' && row.id !== leader.id && !places.get(row.id)?.leave);
    const pinOf = new Map(all.map(m => [m.id, m.pin]));
    const { ready, sync } = readyCopies(ctx, holding, now);
    const numbered = ranked.flatMap(one => (one.number !== null && one.number >= 2 ? [{ id: one.id, number: one.number }] : []));
    const roles = planRoles({
      numbered,
      data: holding.map(row => ({ id: row.id, number: places.get(row.id)?.number ?? null, out: pinOf.get(row.id) === 'none' })),
      eligible: new Set(others.filter(m => unfit(m, fit) === null && !m.owes && m.reportAt !== null && now.getTime() - m.reportAt.getTime() <= REPORT_FRESH_MS).map(m => m.id)),
      ready, sync,
      handoverAt: kept?.handover_at ? new Date(kept.handover_at) : null,
      now, ceo: Boolean(opts.ceo),
      /* The machine the CEO asked the server moved to holds its copy while the request stands. */
      target: await moveTargetRow(tx),
    });

    const changes = before.flatMap(row => {
      const spot = places.get(row.id);
      if (!spot) return [];
      const role = roles.grant.includes(row.id) && row.role !== 'data' ? { role: 'data' as const } : {};
      /* A pin ends when its machine becomes number 1. */
      const pin = spot.clearPin ? { serverPin: null } : {};
      return spot.number !== row.serverOrder || spot.why !== row.serverWhy || 'role' in role || spot.clearPin ? [{ id: row.id, set: { serverOrder: spot.number, serverWhy: spot.why, ...role, ...pin } }] : [];
    });
    if (changes.length > 0) {
      /* Every changed row gives its number up first, so two numbers that swap never meet. */
      await tx.update(machines).set({ serverOrder: null }).where(inArray(machines.id, changes.map(change => change.id)));
      for (const change of changes) await tx.update(machines).set(change.set).where(eq(machines.id, change.id));
    }
    if (scored || roles.handover) {
      await q('UPDATE net.ranking SET rescored_at = CASE WHEN $1 THEN $3::timestamptz ELSE rescored_at END, handover_at = CASE WHEN $2 THEN $3::timestamptz ELSE handover_at END', [scored, roles.handover, now]);
    }
    const leave = before.filter(row => places.get(row.id)?.leave).map(({ id, networkId }) => ({ id, networkId }));
    const retiring = before.find(row => row.id === roles.retire);
    return {
      changed: changes.length + cleared.length, scored, leave,
      retire: retiring ? { id: retiring.id, networkId: retiring.networkId, copyName: retiring.copyName } : null,
      top: numbered.filter(one => one.number <= COPIES + 1).map(one => one.id),
    };
  });
}

type Asked = { rescore: boolean; ceo: boolean; waiters: { resolve: () => void; reject: (err: unknown) => void }[] };

/* Ranks while the app leads: at once, with a scoring, then every minute, and whenever asked. */
export class Ranking {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  /* What the run after the one running was asked for, by everyone who asked meanwhile. */
  private asked: Asked | null = null;
  /* A run that failed hands its scoring on to the next. */
  private owed = false;

  constructor(
    private readonly ctx: Ctx,
    private readonly opts: { everyMs?: number } = {},
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.now().catch(() => undefined), this.opts.everyMs ?? RANK_EVERY_MS);
    this.timer.unref();
    void this.now({ rescore: true }).catch(() => undefined);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    const asked = this.asked;
    this.asked = null;
    for (const waiter of asked?.waiters ?? []) waiter.resolve();
  }

  /* A rank as soon as the one running ends, and one more at most however often it is asked meanwhile: that one takes
     what every caller before its start asked for. It ends when that run ended, and fails with what the run failed
     with. */
  now(opts: { rescore?: boolean; ceo?: boolean } = {}): Promise<void> {
    if (!this.timer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.asked ??= { rescore: false, ceo: false, waiters: [] };
      this.asked.rescore ||= Boolean(opts.rescore);
      this.asked.ceo ||= Boolean(opts.ceo);
      this.asked.waiters.push({ resolve, reject });
      this.next();
    });
  }

  private next(): void {
    if (this.running || !this.asked) return;
    const asked = this.asked;
    this.asked = null;
    this.running = this.once({ rescore: asked.rescore || this.owed, ceo: asked.ceo })
      .then(
        () => {
          this.owed = false;
          for (const waiter of asked.waiters) waiter.resolve();
        },
        (err: unknown) => {
          this.owed = true;
          for (const waiter of asked.waiters) waiter.reject(err);
        },
      )
      .finally(() => {
        this.running = null;
        this.next();
      });
  }

  /* A ranking that fails is one line, and the next minute tries again, with a scoring. */
  private async once(opts: { rescore: boolean; ceo: boolean }): Promise<void> {
    /* How fast the leader sends to each machine, as its keeper last said; without it the ranking goes on with what
       the rows hold. */
    await storeThroughput(this.ctx).catch((err: unknown) => this.ctx.log.warn({ error: loggable(err) }, "Could not write how fast the server sends to each machine. The rows keep what they had."));
    try {
      await rank(this.ctx, new Date(), opts);
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err) }, 'Could not number the machines that may hold the data. The next minute tries again.');
      throw err;
    }
  }
}
