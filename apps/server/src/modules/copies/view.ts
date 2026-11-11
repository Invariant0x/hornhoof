import { isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { machines, publicLinks } from '../../db/schema.js';
import { freshState } from '../keeper/state.js';
import { queryOf } from '../merge/leader.js';
import { findThisMachine } from '../network/store.js';
import { candidates } from './order.js';
import { REPORT_FRESH_MS, unfit, type Unfit } from './qualify.js';

/* A copy this far behind the leader's last pulse is said to be behind, in whole minutes. */
const BEHIND_MS = 60_000;

/* How a machine's copy of the company's data does, as its card says it. */
export type CopyLine =
  | { line: 'making' | 'remaking'; progress: number }
  | { line: 'ready' }
  | { line: 'catching_up' }
  | { line: 'behind'; minutes: number }
  | { line: 'asleep'; since: string | null }
  | { line: 'stopped'; why: 'disk_full' | 'setup' | null };

/* A machine's part in holding the company's data. number, why: its place in the order and the key of the words for it.
   unfit: why it holds no copy. copy: how its copy does; none for the leader. leftAt: when it stopped holding the data. */
export type DataView = { number: number | null; why: 'server' | 'next' | null; unfit: Unfit | null; copy: CopyLine | null; leftAt: string | null };

/* Who holds the company: the leader's name, the machines that keep a copy, the one commits wait for marked, and since
   when only the leader holds the changes, when copies there were and none is up to date now. */
export type CopiesView = { leader: string; copies: { hostname: string; sync: boolean }[]; onlySince: string | null };

type Row = typeof machines.$inferSelect;
type Read = { rows: Row[]; leader: Row | null; lines: Map<string, CopyLine>; sync: string | null };

const whyOf = (why: string | null): DataView['why'] => (why === 'server' || why === 'next' ? why : null);

/* Every live machine with the line of its copy. A copy is up to date only on the word of the keeper that leads, which
   reads its own Postgres: a word that is old or missing makes none so. */
async function read(ctx: Ctx, now: Date): Promise<Read> {
  const { db, config } = ctx;
  const rows = await db.select().from(machines).where(isNull(machines.revokedAt)).orderBy(machines.serverOrder, machines.createdAt, machines.id);
  const leader = await findThisMachine(db, config);
  const copies = rows.filter(row => row.role === 'data' && row.id !== leader?.id);
  const lines = new Map<string, CopyLine>();
  if (copies.length === 0) return { rows, leader: rows.find(row => row.id === leader?.id) ?? null, lines, sync: null };
  const slots = await ctx.replication.slots();
  const said = freshState(config.controlDir, now.getTime())?.copies ?? [];
  const [pulse] = await queryOf(db)<{ at: Date | string }>('SELECT at FROM net.pulse');
  const pulseAt = pulse ? new Date(pulse.at).getTime() : null;
  for (const row of copies) {
    const state = said.find(copy => copy.name === row.copyName)?.state ?? null;
    lines.set(row.id, lineOf(row, { now, pulseAt, reads: slots.some(slot => slot.name === row.copyName && slot.pid !== null), state }));
  }
  const sync = copies.find(row => said.some(copy => copy.name === row.copyName && copy.state === 'sync'))?.id ?? null;
  return { rows, leader: rows.find(row => row.id === leader?.id) ?? null, lines, sync };
}

function lineOf(row: Row, o: { now: Date; pulseAt: number | null; reads: boolean; state: 'sync' | 'pace' | 'behind' | 'silent' | null }): CopyLine {
  /* A machine that was given the data and has said nothing of a copy yet is at the start of making one. */
  if (row.copyState === null) return { line: 'making', progress: 0 };
  if (row.copyState === 'making' || row.copyState === 'remaking') return { line: row.copyState, progress: row.copyProgress ?? 0 };
  if (row.copyState === 'stopped') return { line: 'stopped', why: row.copyError === 'disk_full' || row.copyError === 'setup' ? row.copyError : null };
  const reported = row.reportAt !== null && o.now.getTime() - row.reportAt.getTime() <= REPORT_FRESH_MS;
  if (!o.reads || !reported) return { line: 'asleep', since: row.copyAt?.toISOString() ?? null };
  if (o.state === 'sync' || o.state === 'pace') return { line: 'ready' };
  const behind = o.pulseAt !== null && row.copyAt ? o.pulseAt - row.copyAt.getTime() : 0;
  return behind > BEHIND_MS ? { line: 'behind', minutes: Math.floor(behind / 60_000) } : { line: 'catching_up' };
}

/* Both at once, from one reading, for the tab that shows them together. */
export async function holding(ctx: Ctx, now = new Date()): Promise<{ views: Map<string, DataView>; copies: CopiesView | null }> {
  const all = await read(ctx, now);
  return { views: await viewsOf(ctx, all, now), copies: copiesOf(all) };
}

/* Each live machine's part in holding the data, by its id. */
export async function dataViews(ctx: Ctx, now = new Date()): Promise<Map<string, DataView>> {
  return viewsOf(ctx, await read(ctx, now), now);
}

async function viewsOf(ctx: Ctx, { rows, lines }: Read, now: Date): Promise<Map<string, DataView>> {
  const { db } = ctx;
  const [sized] = await queryOf(db)<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
  const [link] = await db.select({ name: publicLinks.name }).from(publicLinks).limit(1);
  const fit = { dbSize: Number(sized?.size ?? 0), link: Boolean(link), now };
  const byId = new Map((await candidates(db)).map(candidate => [candidate.id, candidate]));
  return new Map(
    rows.map(row => {
      const candidate = byId.get(row.id);
      /* A machine with a place, or one that holds the data, needs no reason; any other says the first thing that keeps
         it from holding a copy. */
      const reason = row.serverOrder === null && row.role !== 'data' && candidate ? unfit(candidate, fit) : null;
      return [row.id, { number: row.serverOrder, why: whyOf(row.serverWhy), unfit: reason, copy: lines.get(row.id) ?? null, leftAt: row.dataLeftAt?.toISOString() ?? null }];
    }),
  );
}

/* The tab's line of who holds the company; null while no machine keeps a copy. */
export async function copiesView(ctx: Ctx, now = new Date()): Promise<CopiesView | null> {
  return copiesOf(await read(ctx, now));
}

function copiesOf({ rows, leader, lines, sync }: Read): CopiesView | null {
  const copies = rows.filter(row => lines.has(row.id));
  if (!leader || copies.length === 0) return null;
  const had = copies.filter(row => row.copyAt !== null);
  const none = had.length > 0 && !copies.some(row => lines.get(row.id)?.line === 'ready');
  const newest = had.reduce<Date | null>((a, row) => (!a || row.copyAt! > a ? row.copyAt : a), null);
  return { leader: leader.hostname, copies: copies.map(row => ({ hostname: row.hostname, sync: row.id === sync })), onlySince: none ? (newest?.toISOString() ?? null) : null };
}
