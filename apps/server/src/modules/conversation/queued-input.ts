import { and, asc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs } from '../../db/schema.js';
import { readMessage } from '../events/parties.js';
import { addressed } from './prompt.js';

const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/* A program may open only words kept in the turn they were sent to, each message once. */
export async function queuedInput(ctx: Ctx, agentId: string, jobId: string, text: string) {
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId)));
  if (!job || (job.status !== 'running' && (!job.finishedAt || Date.now() - +job.finishedAt > 15_000))) return null;
  const messages = await ctx.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, agentId), eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'))).orderBy(asc(agentEvents.seq));
  for (const event of messages) {
    const { data, message } = readMessage(event.data);
    const words = (data as { text?: unknown }).text;
    if (typeof words !== 'string' || !message || flat(addressed(words, message)) !== flat(text)) continue;
    const [used] = await ctx.db.select({ id: agentEvents.id }).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->>'queuedEvent' = ${String(event.seq)}`)).limit(1);
    if (!used) return { seq: event.seq, personId: event.personId, message };
  }
  return null;
}
