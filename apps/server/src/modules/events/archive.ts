import { gunzipSync, gzipSync } from 'node:zlib';
import { and, arrayOverlaps, asc, desc, eq, gt, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEventArchives, agentEvents, companies, turns, type AgentEventKind } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Files } from '../files/files.js';
import type { Query } from '../merge/facts.js';
import { StoreRefused } from '../files/store.js';

/* An agent's old history in the file store (#2126). The text, tool, tool_result and todo events of a job that ended
   before the company's window leave agent_events for a gzipped file of JSON lines that a row of agent_event_archives
   names; every message, typed, program and failed event, and every event that carries a mark a "send once" check
   reads, stays in the table. The readers of an agent's history take the archived events back by their seq. */

export const ARCHIVED_KINDS = ['text', 'tool', 'tool_result', 'todo'] as const satisfies readonly AgentEventKind[];
/* The days an ended job's history stays in the table unless the CEO sets others, and the most they may set. */
export const HISTORY_DAYS = 14;
export const MAX_HISTORY_DAYS = 3650;
/* The marks other parts of the app look an event up by, whatever its kind: one that carries any stays in the table. */
export const KEPT_MARKS = ['failureCase', 'silentJob', 'operationsPending', 'operatorEvidenceId', 'operatorEvidence', 'operatorEscalation', 'operatorFallback',
  'operatorDelivery', 'operatorAction', 'queuedEvent', 'undelivered', 'report', 'from'] as const;
/* The jobs one round looks at, and the most events one file holds; a job's events go into one file whole. */
export const JOBS_A_ROUND = 100;
export const FILE_EVENTS = 1_000;
/* How often the round looks for jobs to archive once it caught up: at every minute round while it is behind, else once
   an hour. The archives waiting for their copies are looked at every minute. */
export const IDLE_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ENDED = ['done', 'failed', 'obsolete'] as const;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
const listed = (values: readonly string[]) => values.map(value => `'${value}'`).join(', ');

/* An event that may leave the table, as SQL over agent_events under this alias. Every word in it is this file's own. */
export const archivable = (alias = 'agent_events'): SQL =>
  sql.raw(`(${alias}.kind IN (${listed(ARCHIVED_KINDS)}) AND ${alias}.job_id IS NOT NULL AND NOT (${alias}.data ?| ARRAY[${listed(KEPT_MARKS)}]::text[]))`);

/* An archived event as its file keeps it: what agent_events held of it, its time to the millisecond as the readers give it. */
export type ArchivedEvent = { id: string; seq: number; kind: AgentEventKind; data: unknown; jobId: string; personId: string | null; createdAt: string };

export function archiveBytes(events: readonly ArchivedEvent[]): Buffer {
  return gzipSync(Buffer.from(events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8'));
}

export function archivedOf(bytes: Buffer): ArchivedEvent[] {
  return gunzipSync(bytes).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as ArchivedEvent);
}

/* What one archive holds, read once for a few: a file is never written again under its name. */
const READ_KEEP = 8;
const read = new Map<string, ArchivedEvent[]>();
async function opened(ctx: { db: Db; files: Pick<Files, 'bytes'> }, sha256: string): Promise<ArchivedEvent[]> {
  const known = read.get(sha256);
  if (known) return known;
  const events = archivedOf(await ctx.files.bytes(ctx.db, sha256).catch(lostAsNone));
  read.set(sha256, events);
  if (read.size > READ_KEEP) read.delete(read.keys().next().value!);
  return events;
}

/* A file the store has no copy of any more is lost with its disk: it holds nothing to show. One a machine away holds is
   no answer yet, and says so. */
function lostAsNone(err: unknown): Buffer {
  if ((err instanceof ApiError && err.reason === 'file_lost') || (err instanceof StoreRefused && err.reason === 'missing')) return gzipSync(Buffer.alloc(0));
  throw err;
}

/* Which archived events a reader wants: those of an agent, or of these jobs, between two seqs, the oldest or the newest
   first, at most limit of them, and of those only the ones keep takes. */
export type ArchivedRange = { agentId?: string; jobs?: string[]; after?: number; before?: number; newest: boolean; limit: number; keep?: (event: ArchivedEvent) => boolean };

/* The archived events a reader wants, in the order it asked for, each once. Only the archives that may hold one are
   opened, the nearest first, and no further one once there are enough nearer than it reaches. */
export async function archivedEvents(ctx: { db: Db; files: Pick<Files, 'bytes'> }, range: ArchivedRange): Promise<ArchivedEvent[]> {
  if (range.limit <= 0 || range.jobs?.length === 0) return [];
  const x = agentEventArchives;
  const archives = await ctx.db
    .select({ sha256: x.sha256, firstSeq: x.firstSeq, lastSeq: x.lastSeq })
    .from(x)
    .where(and(
      range.agentId ? eq(x.agentId, range.agentId) : undefined,
      range.jobs ? arrayOverlaps(x.jobIds, range.jobs) : undefined,
      range.after === undefined ? undefined : gt(x.lastSeq, range.after),
      range.before === undefined ? undefined : lt(x.firstSeq, range.before),
    ))
    .orderBy(range.newest ? desc(x.lastSeq) : asc(x.firstSeq));
  const jobs = range.jobs ? new Set(range.jobs) : null;
  const order = (a: ArchivedEvent, b: ArchivedEvent) => (range.newest ? b.seq - a.seq : a.seq - b.seq);
  const found = new Map<string, ArchivedEvent>();
  for (const archive of archives) {
    if (found.size >= range.limit) {
      const edge = [...found.values()].sort(order)[range.limit - 1]!.seq;
      if (range.newest ? archive.lastSeq < edge : archive.firstSeq > edge) break;
    }
    for (const event of await opened(ctx, archive.sha256)) {
      if (range.after !== undefined && event.seq <= range.after) continue;
      if (range.before !== undefined && event.seq >= range.before) continue;
      if ((jobs && !jobs.has(event.jobId)) || (range.keep && !range.keep(event))) continue;
      found.set(event.id, event);
    }
  }
  return [...found.values()].sort(order).slice(0, range.limit);
}

/* The ids of these events that an archive of this database holds: what a merge does not add again. */
export async function archivedIds(q: Query, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await q<{ id: string }>('SELECT DISTINCT e.id::text AS id FROM public.agent_event_archives x, unnest(x.event_ids) e(id) WHERE x.event_ids && $1::uuid[] AND e.id = ANY($1::uuid[])', [`{${ids.join(',')}}`]);
  return new Set(rows.map(row => row.id));
}

export type ArchiveRound = { archived: number; cleared: number; behind: boolean; stays?: 'no_files_dir' };

/* One round: the archives whose files stand on their copies now give up their events, then each company's jobs that
   ended before its window, the latest first, go into new archives, a few at a time. A server with no FILES_DIR, whose
   store is a folder of this run alone, keeps everything in the table. behind: there is more to do at the next round. */
export async function archiveRound(ctx: Pick<Ctx, 'db' | 'files' | 'config'>, now = new Date()): Promise<ArchiveRound> {
  if (!ctx.config.filesDir) return { archived: 0, cleared: 0, behind: false, stays: 'no_files_dir' };
  let cleared = await clearStanding(ctx, now);
  let archived = 0;
  let full = false;
  for (const company of await ctx.db.select({ id: companies.id, days: companies.historyDays }).from(companies)) {
    const done = await archiveCompany(ctx, company.id, await cutoffOf(ctx.db, company.id, company.days, now));
    archived += done.archived;
    full ||= done.full;
  }
  cleared += await clearStanding(ctx, now);
  return { archived, cleared, behind: full };
}

/* The round as the minute round runs it: the archives that wait for their copies every minute, and the jobs to archive at
   once while the last look found more than one round takes, else an hour after it. */
const nextRound = new WeakMap<object, number>();
export async function pacedArchiveRound(ctx: Pick<Ctx, 'db' | 'files' | 'config'>, now = new Date()): Promise<ArchiveRound | null> {
  if (!ctx.config.filesDir) return null;
  if ((nextRound.get(ctx.db) ?? 0) > now.getTime()) return { archived: 0, cleared: await clearStanding(ctx, now), behind: false };
  const round = await archiveRound(ctx, now);
  nextRound.set(ctx.db, round.behind ? 0 : now.getTime() + IDLE_EVERY_MS);
  return round;
}

/* The moment before which an ended job's history leaves the table: the company's days back from now, and never after a
   turn that is still open began, whose facts are read from the events of its time. */
async function cutoffOf(db: Db, companyId: string, days: number, now: Date): Promise<Date> {
  const [open] = await db
    .select({ at: sql<Date | string | null>`min(coalesce(${turns.openedAt}, ${turns.createdAt}))` })
    .from(turns)
    .where(and(eq(turns.companyId, companyId), eq(turns.status, 'open')));
  const window = now.getTime() - Math.max(1, days) * DAY_MS;
  return new Date(open?.at ? Math.min(window, new Date(open.at).getTime()) : window);
}

type Row = ArchivedEvent & { agentId: string };

async function archiveCompany(ctx: Pick<Ctx, 'db' | 'files'>, companyId: string, cutoff: Date): Promise<{ archived: number; full: boolean }> {
  const { db } = ctx;
  const picked = rowsOf<{ id: string }>(await db.execute(sql`SELECT j.id FROM jobs j
    WHERE j.company_id = ${companyId} AND j.status IN (${sql.join(ENDED.map(status => sql`${status}`), sql`, `)})
      AND coalesce(j.finished_at, j.created_at) < ${cutoff.toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM agent_events e WHERE e.job_id = j.id AND ${archivable('e')})
      AND NOT EXISTS (SELECT 1 FROM agent_event_archives x WHERE x.cleared_at IS NULL AND x.job_ids @> ARRAY[j.id])
    ORDER BY coalesce(j.finished_at, j.created_at) DESC, j.id
    LIMIT ${JOBS_A_ROUND}`));
  if (picked.length === 0) return { archived: 0, full: false };
  const rows: Row[] = (await db
    .select({ id: agentEvents.id, seq: agentEvents.seq, kind: agentEvents.kind, data: agentEvents.data, jobId: agentEvents.jobId, personId: agentEvents.personId, agentId: agentEvents.agentId, createdAt: agentEvents.createdAt })
    .from(agentEvents)
    .where(and(inArray(agentEvents.jobId, picked.map(job => job.id)), archivable()))
    .orderBy(asc(agentEvents.agentId), asc(agentEvents.seq)))
    .map(row => ({ ...row, jobId: row.jobId!, createdAt: row.createdAt.toISOString() }));
  let archived = 0;
  for (const chunk of chunksOf(rows)) archived += await keepArchive(ctx, companyId, chunk);
  return { archived, full: picked.length === JOBS_A_ROUND };
}

/* An agent's events in files of at most FILE_EVENTS, each job's whole in one; a job with more has a file of its own. */
function chunksOf(rows: readonly Row[]): Row[][] {
  const byAgent = new Map<string, Map<string, Row[]>>();
  for (const row of rows) {
    const jobs = byAgent.get(row.agentId) ?? new Map<string, Row[]>();
    byAgent.set(row.agentId, jobs);
    jobs.set(row.jobId, [...(jobs.get(row.jobId) ?? []), row]);
  }
  const chunks: Row[][] = [];
  for (const jobs of byAgent.values()) {
    let chunk: Row[] = [];
    for (const events of jobs.values()) {
      if (chunk.length > 0 && chunk.length + events.length > FILE_EVENTS) {
        chunks.push(chunk);
        chunk = [];
      }
      chunk.push(...events);
    }
    if (chunk.length > 0) chunks.push(chunk);
  }
  return chunks.map(chunk => [...chunk].sort((a, b) => a.seq - b.seq));
}

/* Keeps one file and its row. The row is written only while the events are as they were read, held until it is: one
   changed meanwhile, as by a secret hidden, is read again at a later round, and the file left behind goes with the store's
   round as no row names it. */
async function keepArchive(ctx: Pick<Ctx, 'db' | 'files'>, companyId: string, chunk: Row[]): Promise<number> {
  const events: ArchivedEvent[] = chunk.map(row => ({ id: row.id, seq: row.seq, kind: row.kind, data: row.data, jobId: row.jobId, personId: row.personId, createdAt: row.createdAt }));
  const kept = await ctx.files.putBytes(ctx.db, archiveBytes(events));
  return ctx.db.transaction(async tx => {
    const ids = events.map(event => event.id);
    const now = rowsOf<{ id: string; data: unknown }>(await tx.execute(sql`SELECT id, data FROM agent_events WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[]) FOR UPDATE`));
    const was = new Map(events.map(event => [event.id, JSON.stringify(event.data)]));
    if (now.length !== events.length || now.some(row => was.get(row.id) !== JSON.stringify(row.data))) return 0;
    await tx.insert(agentEventArchives).values({
      companyId,
      agentId: chunk[0]!.agentId,
      sha256: kept.sha256,
      firstSeq: events[0]!.seq,
      lastSeq: events.at(-1)!.seq,
      events: events.length,
      jobIds: [...new Set(events.map(event => event.jobId))],
      eventIds: ids,
      firstAt: new Date(Math.min(...events.map(event => Date.parse(event.createdAt)))),
      lastAt: new Date(Math.max(...events.map(event => Date.parse(event.createdAt)))),
    });
    return events.length;
  });
}

/* The archives not cleared yet whose file stands on as many machines as the company asks for: their events leave the
   table. A few are looked at a round, each in its turn, so those whose copies cannot stand yet keep none of the others
   waiting. Says how many events left. */
const clearedAfter = new WeakMap<object, string>();
async function clearStanding(ctx: Pick<Ctx, 'db' | 'files'>, now: Date): Promise<number> {
  const x = agentEventArchives;
  const after = clearedAfter.get(ctx.db);
  const waiting = await ctx.db.select({ id: x.id, sha256: x.sha256 }).from(x).where(and(isNull(x.clearedAt), after ? gt(x.id, after) : undefined)).orderBy(asc(x.id)).limit(JOBS_A_ROUND);
  if (waiting.length < JOBS_A_ROUND) clearedAfter.delete(ctx.db);
  else clearedAfter.set(ctx.db, waiting.at(-1)!.id);
  let cleared = 0;
  for (const archive of waiting) {
    if (!(await ctx.files.copiesStand(ctx.db, archive.sha256))) continue;
    cleared += await ctx.db.transaction(async tx => {
      const gone = rowsOf<{ id: string }>(await tx.execute(sql`DELETE FROM agent_events e USING agent_event_archives x
        WHERE x.id = ${archive.id} AND x.cleared_at IS NULL AND e.id = ANY(x.event_ids) AND ${archivable('e')} RETURNING e.id`));
      await tx.update(x).set({ clearedAt: now }).where(and(eq(x.id, archive.id), isNull(x.clearedAt)));
      return gone.length;
    });
  }
  return cleared;
}

/* The days an ended job's history stays in the table, as the company has them. */
export async function historyDays(db: Pick<Db, 'select'>, companyId: string): Promise<number> {
  const [row] = await db.select({ days: companies.historyDays }).from(companies).where(eq(companies.id, companyId));
  return row?.days ?? HISTORY_DAYS;
}

export async function setHistoryDays(db: Pick<Db, 'update'>, companyId: string, days: number): Promise<void> {
  await db.update(companies).set({ historyDays: days }).where(eq(companies.id, companyId));
}
