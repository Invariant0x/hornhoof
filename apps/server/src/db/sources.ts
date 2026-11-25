import { AsyncLocalStorage } from 'node:async_hooks';
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { writeGate } from './gate.js';
import { applied, nodeStreamFloors } from './schema.js';

/* The work running now, when a node message, a page's request or a tool call started it: its name without a step, the
   step its next commit takes, whether it still runs, and whether any step of it committed. */
export type Source = { base: string; next: number; open: boolean; wrote: boolean };

export const sources = new AsyncLocalStorage<Source>();

export const nodeStream = (node: string, stream: string): string => `node:${node}:${stream}`;
export const nodeSource = (node: string, stream: string, n: number): string => `${nodeStream(node, stream)}:${n}`;
export const webSource = (id: string): string => `web:${id}`;
export const toolSource = (invocation: string): string => `tool:${invocation}`;
export const stepOf = (base: string, step: number): string => `${base}:${step}`;

export function openSource(base: string, next = 0): Source {
  return { base, next, open: true, wrote: false };
}

/* The source closes when the work settles, so a timer the work left behind records nothing. */
export function withSource<T>(base: string, work: () => Promise<T>, next?: number): Promise<T> {
  const source = openSource(base, next);
  return sources.run(source, () => work().finally(() => { source.open = false; }));
}

/* The work is awaited here, outside: a drizzle query runs where it is awaited, not where it is built. */
export function outsideSources<T>(work: () => PromiseLike<T> | T): Promise<T> {
  return sources.exit(async () => await work());
}

/* A statement that changes rows: it starts with insert, update or delete, or with `with` and holds one of them. */
export const WRITE_TEXT = /^\s*(?:insert|update|delete)\b|^\s*with\b[\s\S]*\b(?:insert|update|delete)\b/i;

type Work<T> = (tx: Db) => Promise<T>;
type Config = { accessMode?: 'read only' | 'read write' } | undefined;
type Prepared = { execute(values?: unknown, token?: unknown): Promise<unknown> };
/* What drizzle 0.45.4 keeps under a db: the session that prepares each query and opens each transaction. */
type Session = {
  prepareQuery(query: { sql: string }, ...rest: unknown[]): Prepared;
  transaction<T>(work: Work<T>, config?: Config): Promise<T>;
  [RECORDS]?: true;
};
const RECORDS = Symbol('records sources');
const sessionOf = (db: Db): Session => (db as unknown as { session: Session }).session;

const openNow = (): Source | undefined => {
  const source = sources.getStore();
  return source?.open ? source : undefined;
};

/* Every change to a row takes a transaction id, so a transaction with one wrote, and its step goes in before its commit,
   in one statement. A step number is taken either way: one that is not written leaves a gap, as a failed commit does. */
async function recordStep(tx: Db, source: Source): Promise<boolean> {
  const step = stepOf(source.base, source.next++);
  const answer = (await tx.execute(sql`INSERT INTO applied (source, base) SELECT ${step}, ${source.base} WHERE pg_current_xact_id_if_assigned() IS NOT NULL RETURNING 1`)) as unknown as { rows: unknown[] };
  return answer.rows.length > 0;
}

async function insertStep(tx: Db, source: Source): Promise<void> {
  const step = source.next++;
  await tx.insert(applied).values({ source: stepOf(source.base, step), base: source.base });
}

/* A transaction that may write goes through the gate of the app's writes before it begins, in a source or not. */
function recordingTransaction(session: Session): Session['transaction'] {
  const transaction = session.transaction.bind(session);
  return async <T>(work: Work<T>, config?: Config): Promise<T> => {
    if (config?.accessMode === 'read only') return transaction(work, config);
    return writeGate.through(async () => {
      const source = openNow();
      if (!source) return transaction(work, config);
      let recorded = false;
      const result = await transaction(async tx => {
        const answer = await work(tx);
        recorded = await recordStep(tx, source);
        return answer;
      }, config);
      if (recorded) source.wrote = true;
      return result;
    });
  };
}

/* A write outside a transaction goes through the gate too. In a source it runs as the same query in a transaction of its
   own, which records its step. */
function recordingPrepare(db: Db, session: Session): Session['prepareQuery'] {
  const prepare = session.prepareQuery.bind(session);
  return (query, ...rest) => {
    const prepared = prepare(query, ...rest);
    if (!WRITE_TEXT.test(query.sql)) return prepared;
    const execute = prepared.execute.bind(prepared);
    prepared.execute = (values, token) =>
      writeGate.through(async () => (openNow() ? db.transaction(tx => sessionOf(tx).prepareQuery(query, ...rest).execute(values, token)) : execute(values, token)));
    return prepared;
  };
}

/* The same db, wrapped once: every transaction that may write, and every write outside one, waits at the gate of the
   app's writes while a merge holds it; and inside an open source, each transaction that wrote, and each write outside
   a transaction, lists its step of the source in `applied` in its own commit. It reaches into drizzle's session, the
   one place that does, and the tests of sources fail if drizzle changes it. */
export function recordSources<T extends Db>(db: T): T {
  const session = sessionOf(db);
  if (session[RECORDS]) return db;
  session[RECORDS] = true;
  session.transaction = recordingTransaction(session);
  session.prepareQuery = recordingPrepare(db, session);
  return db;
}

/* For an action outside the database: its step commits before the action, so a retry hears that it began. */
export async function recordNow(db: Db): Promise<void> {
  const source = openNow();
  if (!source) return;
  await outsideSources(() => db.transaction(tx => insertStep(tx, source)));
  source.wrote = true;
}

/* The steps of a source that committed: how many, the first one's name and time, and the step its next commit takes,
   above every one it has. Null when none did. */
export async function listed(db: Db, base: string): Promise<{ steps: number; first: string; at: Date; next: number } | null> {
  const rows = await db.select({ source: applied.source, at: applied.at }).from(applied).where(eq(applied.base, base)).orderBy(asc(applied.at), asc(applied.source));
  if (!rows[0]) return null;
  const last = Math.max(...rows.map(row => Number(row.source.slice(base.length + 1))));
  return { steps: rows.length, first: rows[0].source, at: rows[0].at, next: last + 1 };
}

/* Whether a node's message is at or below the floor of its stream, whose steps were pruned: handled here, as every
   message of the stream up to the floor was. */
export async function belowFloor(db: Db, stream: string, n: number): Promise<boolean> {
  const [row] = await db.select({ upto: nodeStreamFloors.upto }).from(nodeStreamFloors).where(eq(nodeStreamFloors.stream, stream));
  return row !== undefined && n <= row.upto;
}

/* Writes a source's first step again as it is, so the journal carries it to whoever keeps a copy, and no step is taken. */
export async function touch(db: Db, first: string): Promise<void> {
  await outsideSources(() => db.execute(sql`UPDATE applied SET at = at WHERE source = ${first}`));
}
