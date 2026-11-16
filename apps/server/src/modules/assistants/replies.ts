import { and, asc, eq, gt } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, assistantReplies, jobs, type AssistantEventKind } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { turnGoingOn } from '../conversation/queue.js';
import { storeEvent } from './events.js';

type ReplyRow = typeof assistantReplies.$inferSelect;
/* Tells of a new event of an assistant once it is kept. worth: the event is worth a turn of a program's model whatever its
   kind. */
export type Told = (assistantId: string, seq: number, kind: AssistantEventKind, worth?: boolean) => void;

const OPEN = ['queued', 'running'];
const textOf = (data: unknown): string => (data && typeof data === 'object' && 'text' in data && typeof data.text === 'string' ? data.text : '');

/* The agent an answer is from, as an event names it. */
async function agentOf(ctx: Pick<Ctx, 'db'>, agentId: string) {
  const [agent] = await ctx.db.select({ id: agents.id, name: agents.name, kind: agents.kind }).from(agents).where(eq(agents.id, agentId));
  return agent ?? { id: agentId, name: '', kind: 'worker' as const };
}

/* What the agent said since the last word passed on, each as a reply, kept together with how far it got. */
async function passOn(ctx: Ctx, row: ReplyRow, told: Told): Promise<boolean> {
  const said = await ctx.db
    .select({ seq: agentEvents.seq, data: agentEvents.data })
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, row.jobId), eq(agentEvents.kind, 'text'), gt(agentEvents.seq, row.afterSeq)))
    .orderBy(asc(agentEvents.seq));
  if (!said.length) return row.answered;
  const agent = await agentOf(ctx, row.agentId);
  for (const words of said) {
    const data = { messageId: row.messageId, agent, text: textOf(words.data) };
    const seq = await storeEvent(ctx.db, { companyId: row.companyId, assistantId: row.assistantId, kind: 'reply', data }, async tx => {
      await tx.update(assistantReplies).set({ afterSeq: words.seq, answered: true }).where(eq(assistantReplies.id, row.id));
    });
    told(row.assistantId, seq, 'reply');
  }
  return true;
}

/* One message's answer: what was said since, and, once its turn and every turn going on from it is over and stayed over for
   the grace, its end. Returns when to look again for an end that waits for the grace, if it does. */
async function collectOne(ctx: Ctx, row: ReplyRow, told: Told, graceMs: number, now: Date): Promise<number | null> {
  /* Whether the turn is over is read before its words, so none it said before its end is missed. */
  const [job] = await ctx.db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, row.jobId));
  const over = !job || !OPEN.includes(job.status);
  const answered = await passOn(ctx, row, told);
  if (!over) return null;
  const next = await turnGoingOn(ctx, row.jobId);
  if (next) {
    await ctx.db.update(assistantReplies).set({ jobId: next.id, endedAt: null }).where(eq(assistantReplies.id, row.id));
    return 0;
  }
  const ended = row.endedAt ?? now;
  const left = ended.getTime() + graceMs - now.getTime();
  if (left > 0) {
    if (!row.endedAt) await ctx.db.update(assistantReplies).set({ endedAt: ended }).where(eq(assistantReplies.id, row.id));
    return left;
  }
  const data = { messageId: row.messageId, agent: await agentOf(ctx, row.agentId), answered, failed: job?.status === 'failed' };
  const seq = await storeEvent(ctx.db, { companyId: row.companyId, assistantId: row.assistantId, kind: 'reply_end', data }, async tx => {
    await tx.delete(assistantReplies).where(eq(assistantReplies.id, row.id));
  });
  told(row.assistantId, seq, 'reply_end');
  return null;
}

/* Words an assistant's own agent sends its owner on its own, for the program to pass on in the owner's chat: one reply with
   no message of the program that it answers, and no end. The program passes on every such reply, so nothing else keeps one:
   a reply to a message always names it. */
export async function tellOwner(ctx: Ctx, to: { companyId: string; assistantId: string }, agentId: string, text: string, told: Told): Promise<void> {
  const data = { messageId: null, agent: await agentOf(ctx, agentId), text };
  told(to.assistantId, await storeEvent(ctx.db, { ...to, kind: 'reply', data }), 'reply', true);
}

/* Every answer the company's assistants wait for. Returns when to look again, or null when nothing waits for a time. */
export async function collectReplies(ctx: Ctx, companyId: string, told: Told, graceMs: number, now = new Date()): Promise<{ again: number | null; waiting: boolean }> {
  const rows = await ctx.db.select().from(assistantReplies).where(eq(assistantReplies.companyId, companyId)).orderBy(asc(assistantReplies.createdAt));
  let again: number | null = null;
  for (const row of rows) {
    const after = await collectOne(ctx, row, told, graceMs, now);
    if (after !== null) again = again === null ? after : Math.min(again, after);
  }
  return { again, waiting: rows.length > 0 };
}
