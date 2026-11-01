import { and, asc, eq, lt } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { pendingWakes } from '../../db/schema.js';
import type { Tx, Wake, WakeWhy } from './engine.js';

/* A wake nobody queued for a day is given up. */
const GIVE_UP_MS = 24 * 3_600_000;

/* The wakes a move needs, written in the move's own transaction. */
export async function keepWakes(tx: Tx | Db, companyId: string, wakes: Wake[]): Promise<void> {
  if (!wakes.length) return;
  await tx.insert(pendingWakes).values(wakes.map(w => ({ companyId, agentId: w.agentId, taskId: w.taskId, why: w.why, text: w.text ?? null, note: w.note ?? null })));
}

/* The turn for this wake is queued, or another one for the same agent and task covers it. */
export async function wakeQueued(db: Db, w: Wake): Promise<void> {
  const same = and(eq(pendingWakes.agentId, w.agentId), eq(pendingWakes.taskId, w.taskId), eq(pendingWakes.why, w.why));
  await db.delete(pendingWakes).where(w.why === 'explain' ? and(same, eq(pendingWakes.text, w.text ?? '')) : same);
}

/* Wakes written before the given time that nobody queued, oldest first. */
export async function wakesLeft(db: Db, before: Date): Promise<Wake[]> {
  await db.delete(pendingWakes).where(lt(pendingWakes.createdAt, new Date(before.getTime() - GIVE_UP_MS)));
  const rows = await db.select().from(pendingWakes).where(lt(pendingWakes.createdAt, before)).orderBy(asc(pendingWakes.createdAt));
  return rows.map(r => ({ agentId: r.agentId, taskId: r.taskId, why: r.why as WakeWhy, ...(r.text !== null ? { text: r.text } : {}), ...(r.note !== null ? { note: r.note } : {}) }));
}
