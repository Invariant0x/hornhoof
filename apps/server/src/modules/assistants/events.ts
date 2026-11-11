import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { assistantEvents, assistantSeqs, type AssistantEventKind } from '../../db/schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/* How long an assistant's events are kept, and how many one read returns. */
export const KEPT_DAYS = 30;
export const PAGE = 100;

export type NewAssistantEvent = { companyId: string; assistantId: string; kind: AssistantEventKind; data: Record<string, unknown> };
export type AssistantEventView = { seq: number; kind: AssistantEventKind; at: string; data: unknown };

/* Keeps an event under the company's next number, with whatever else must be kept with it. The counter's row stays locked
   until the event commits, so the numbers commit in the order they grow. Returns the number. */
export async function storeEvent(db: Db, e: NewAssistantEvent, also?: (tx: Tx) => Promise<void>): Promise<number> {
  return db.transaction(async tx => {
    const [counter] = await tx
      .insert(assistantSeqs)
      .values({ companyId: e.companyId, seq: 1 })
      .onConflictDoUpdate({ target: assistantSeqs.companyId, set: { seq: sql`${assistantSeqs.seq} + 1` } })
      .returning({ seq: assistantSeqs.seq });
    await tx.insert(assistantEvents).values({ ...e, seq: counter!.seq });
    if (also) await also(tx);
    return counter!.seq;
  });
}

/* The assistant's events after a number, oldest first, a page at a time. */
export async function eventsAfter(db: Db, assistantId: string, after: number): Promise<AssistantEventView[]> {
  const rows = await db
    .select({ seq: assistantEvents.seq, kind: assistantEvents.kind, at: assistantEvents.createdAt, data: assistantEvents.data })
    .from(assistantEvents)
    .where(and(eq(assistantEvents.assistantId, assistantId), gt(assistantEvents.seq, after)))
    .orderBy(asc(assistantEvents.seq))
    .limit(PAGE);
  return rows.map(r => ({ ...r, at: r.at.toISOString() }));
}

/* Takes away the events older than KEPT_DAYS. */
export async function sweepEvents(db: Db, now = new Date()): Promise<void> {
  await db.delete(assistantEvents).where(lt(assistantEvents.createdAt, new Date(now.getTime() - KEPT_DAYS * 86_400_000)));
}
