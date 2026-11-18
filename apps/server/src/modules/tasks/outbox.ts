import { and, asc, eq, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { pendingWakes } from '../../db/schema.js';
import type { Tx, Wake, WakeWhy } from './engine.js';

/* A wake nobody queued for a day is given up. */
const GIVE_UP_MS = 24 * 3_600_000;

const wakeRow = (companyId: string, w: Wake): typeof pendingWakes.$inferInsert => ({
  companyId, agentId: w.agentId, taskId: w.taskId, why: w.why, text: w.text ?? null, note: w.note ?? null, taskVersion: w.version ?? null, cause: w.cause ?? null,
});

/* The wakes a move needs, written in the move's own transaction. */
export async function keepWakes(tx: Tx | Db, companyId: string, wakes: Wake[]): Promise<void> {
  if (!wakes.length) return;
  await tx.insert(pendingWakes).values(wakes.map(w => wakeRow(companyId, w)));
}

/* A move keeps the wakes its task needs now, so those an earlier move kept for it are dropped. A request still waiting to
   be put into words keeps its wake, which reads the request again when it runs. */
export async function dropEarlierWakes(tx: Tx, taskId: string): Promise<void> {
  await tx.delete(pendingWakes).where(and(eq(pendingWakes.taskId, taskId), ne(pendingWakes.why, 'explain'), ne(pendingWakes.why, 'calls'), sql`${pendingWakes.cause}->>'report' is null`));
}

/* The turn for this wake is queued, or another one for the same agent and task covers it. */
export async function wakeQueued(db: Db, w: Wake): Promise<void> {
  const same = and(eq(pendingWakes.agentId, w.agentId), eq(pendingWakes.taskId, w.taskId), eq(pendingWakes.why, w.why));
  const action = w.cause?.callBatch ? sql`${pendingWakes.cause}->>'callBatch' = ${w.cause.callBatch}` : w.cause?.eventId === undefined ? sql`${pendingWakes.cause}->>'report' is null` : sql`${pendingWakes.cause}->>'eventId' = ${String(w.cause.eventId)}`;
  await db.delete(pendingWakes).where(and(same, action, w.why === 'explain' ? eq(pendingWakes.text, w.text ?? '') : undefined));
}

/* Wakes written before the given time that nobody queued, oldest first. */
export async function wakesLeft(db: Db, before: Date): Promise<Wake[]> {
  await db.delete(pendingWakes).where(and(ne(pendingWakes.why, 'calls'), lt(pendingWakes.createdAt, new Date(before.getTime() - GIVE_UP_MS))));
  const rows = await db.select().from(pendingWakes).where(lt(pendingWakes.createdAt, before)).orderBy(asc(pendingWakes.createdAt));
  return rows.map(wakeOf);
}

const wakeOf = (r: typeof pendingWakes.$inferSelect): Wake => ({
  agentId: r.agentId, taskId: r.taskId, why: r.why as WakeWhy, ...(r.cause ? { cause: r.cause } : {}),
  ...(r.text !== null ? { text: r.text } : {}), ...(r.note !== null ? { note: r.note } : {}), ...(r.taskVersion !== null ? { version: r.taskVersion } : {}),
});
