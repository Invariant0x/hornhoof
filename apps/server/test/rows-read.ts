import { sql } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';

/* Postgres counts, per table, the rows its sequential scans read and the rows it fetched through indexes. */
async function counters(db: Db, tables: string[]): Promise<Map<string, number>> {
  /* Counters reach the statistics when the backend reports them; this makes the next report happen now. */
  await db.execute(sql`select pg_stat_force_next_flush()`);
  const res = await db.execute(sql`select relname, coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) as n from pg_stat_user_tables where relname in ${tables}`);
  const rows = (res as unknown as { rows: { relname: string; n: number | string }[] }).rows;
  return new Map(rows.map(r => [r.relname, Number(r.n)]));
}

/* The rows read from each table while run() ran, from the database's own counters. The tables are analyzed first, as
   autovacuum does on a live database, so the planner knows their sizes and picks the plan it would there. */
export async function rowsRead<T>(db: Db, tables: string[], run: () => Promise<T>): Promise<{ result: T; read: Record<string, number> }> {
  await db.execute(sql`analyze`);
  const before = await counters(db, tables);
  const result = await run();
  const after = await counters(db, tables);
  return { result, read: Object.fromEntries(tables.map(t => [t, (after.get(t) ?? 0) - (before.get(t) ?? 0)])) };
}

export type PlanNode = { 'Relation Name'?: string; 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] };

/* The rows a node of a plan and those below it read from the table: those it gave on and those its conditions dropped. */
export function readIn(node: PlanNode, table: string): number {
  const own = node['Relation Name'] === table ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * (node['Actual Loops'] ?? 1) : 0;
  return own + (node.Plans ?? []).reduce((n, p) => n + readIn(p, table), 0);
}

type Client = { transaction<T>(run: (tx: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>): Promise<T> };

/* Thrown to roll the transaction back with the plan in hand. */
class Measured extends Error {
  constructor(readonly plan: PlanNode) {
    super('Rolled back after measuring.');
  }
}

/* The rows one statement reads from the table by itself, without the checks its foreign keys make, from the plan Postgres
   runs for it. It runs in a transaction that is rolled back, so nothing changes. */
export async function statementReads(db: Db, statement: { sql: string; params: unknown[] }, table: string): Promise<number> {
  const client = (db as unknown as { $client: Client }).$client;
  try {
    await client.transaction(async tx => {
      const { rows } = await tx.query(`explain (analyze, format json) ${statement.sql}`, statement.params);
      throw new Measured((rows[0]!['QUERY PLAN'] as { Plan: PlanNode }[])[0]!.Plan);
    });
  } catch (err) {
    if (err instanceof Measured) return readIn(err.plan, table);
    throw err;
  }
  throw new Error('The statement was not measured.');
}
