import { asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines, people, publicLinks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { queryOf } from '../merge/leader.js';
import { SERVER_KEY } from '../nodes/nodes.js';
import { findThisMachine } from '../network/store.js';
import { seesAll, unfit, type Candidate } from './qualify.js';

/* The machines after the leader that hold a copy: numbers 2 and 3. */
export const COPIES = 2;
export const RANK_EVERY_MS = 60_000;

/* A machine's place. number: none for a machine that may not hold the data. why: a key the card turns into words. data:
   it holds the company's data. leave: it holds the data and its person no longer sees the whole company, so it has no
   place, and the data is taken from it. */
export type Ranked = { id: string; number: number | null; why: 'server' | 'next' | null; data: boolean; leave?: true };

/* The CEO's machines first, then those of people who see the whole company, then the older, then by id. */
function byOwnerThenAge(a: Candidate, b: Candidate): number {
  return Number(b.owner.isOwner) - Number(a.owner.isOwner) || Number(b.owner.company) - Number(a.owner.company) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/* The leader is 1. Then the machines that hold a copy already, then the rest that fit, so a ranking never takes a copy
   away: a copy keeps its data wherever it stands and whatever its machine measures now, and goes only with its person's
   scope. The first of the rest fill the places up to 3; from 4 on a machine waits for one of them to leave. */
export function rankOf(all: Candidate[], o: { leader: string; dbSize: number; link: boolean; now: Date }): Ranked[] {
  const others = all.filter(m => m.id !== o.leader);
  const copies = others.filter(m => m.role === 'data');
  const holding = copies.filter(m => seesAll(m.owner)).sort(byOwnerThenAge);
  const fit = others.filter(m => m.role !== 'data' && unfit(m, o) === null).sort(byOwnerThenAge);
  const placed = new Map<string, Ranked>();
  [...holding, ...fit].forEach((m, at) => {
    const number = at + 2;
    const data = m.role === 'data' || number <= COPIES + 1;
    placed.set(m.id, { id: m.id, number, why: data ? null : 'next', data });
  });
  return all.map(m => {
    if (m.id === o.leader) return { id: m.id, number: 1, why: 'server', data: true };
    const left = m.role === 'data' && !seesAll(m.owner);
    return placed.get(m.id) ?? { id: m.id, number: null, why: null, data: false, ...(left ? { leave: true as const } : {}) };
  });
}

/* The live machines with their owners. */
export async function candidates(db: Db): Promise<Candidate[]> {
  const rows = await db
    .select({ machine: machines, isOwner: people.isOwner, scopeKind: people.scopeKind, status: people.status, name: people.name })
    .from(machines)
    .innerJoin(people, eq(people.id, machines.personId))
    .where(isNull(machines.revokedAt))
    .orderBy(asc(machines.createdAt), asc(machines.id));
  return rows.map(({ machine: m, ...person }) => ({
    id: m.id, kind: m.kind, networkId: m.networkId, server: m.machineKey.startsWith(SERVER_KEY), role: m.role, createdAt: m.createdAt, reportAt: m.reportAt,
    memory: m.memory, diskFree: m.diskFree, fsyncP99Ms: m.fsyncP99Ms,
    owner: { isOwner: person.isOwner, company: person.scopeKind === 'company', active: person.status === 'active', name: person.name },
  }));
}

/* Numbers the machines anew and writes only the rows whose place or role changes, all in one transaction. A machine
   that gets one of the first places gets the role data here and nothing else: its keeper sees it and makes its copy.
   Without the row of the machine this app runs on there is no leader to count from, and nothing is written. */
export async function rank(ctx: Ctx, now = new Date()): Promise<{ changed: number }> {
  const { db, config } = ctx;
  if (!(await findThisMachine(db, config))) return { changed: 0 };
  return db.transaction(async tx => {
    const before = await tx.select({ id: machines.id, serverOrder: machines.serverOrder, serverWhy: machines.serverWhy, role: machines.role }).from(machines).where(isNull(machines.revokedAt)).orderBy(asc(machines.id)).for('update');
    const leader = await findThisMachine(tx, config);
    if (!leader) return { changed: 0 };
    const [sized] = await queryOf(tx)<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
    const [link] = await tx.select({ name: publicLinks.name }).from(publicLinks).limit(1);
    const places = new Map(rankOf(await candidates(tx), { leader: leader.id, dbSize: Number(sized?.size ?? 0), link: Boolean(link), now }).map(place => [place.id, place]));
    const changes = before.flatMap(row => {
      const place = places.get(row.id);
      if (!place) return [];
      const role = place.data && row.role !== 'data' ? { role: 'data' as const } : {};
      return place.number !== row.serverOrder || place.why !== row.serverWhy || 'role' in role ? [{ id: row.id, set: { serverOrder: place.number, serverWhy: place.why, ...role } }] : [];
    });
    if (changes.length === 0) return { changed: 0 };
    /* Every changed row gives its number up first, so two numbers that swap never meet. */
    await tx.update(machines).set({ serverOrder: null }).where(inArray(machines.id, changes.map(change => change.id)));
    for (const change of changes) await tx.update(machines).set(change.set).where(eq(machines.id, change.id));
    return { changed: changes.length };
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
    try {
      await rank(this.ctx);
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err) }, 'Could not number the machines that may hold the data. The next minute tries again.');
    }
  }
}
