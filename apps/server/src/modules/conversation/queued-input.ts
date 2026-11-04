import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs } from '../../db/schema.js';
import { readMessage } from '../events/parties.js';
import { wordsForTurn } from './turn-words.js';

/* A program may open only words kept in the turn they were sent to, each message once. */
export async function queuedInput(ctx: Ctx, agentId: string, jobId: string, text: string) {
  const [job] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId)));
  if (!job || (job.status !== 'running' && !job.finishedAt)) return null;
  const messages = (await wordsForTurn(ctx, agentId, jobId, text)).reverse();
  for (const event of messages) {
    const { message } = readMessage(event.data);
    if (!message) continue;
    const [used] = await ctx.db.select({ id: agentEvents.id }).from(agentEvents).where(and(eq(agentEvents.agentId, agentId), sql`${agentEvents.data}->>'queuedEvent' = ${String(event.seq)}`)).limit(1);
    if (!used) return { seq: event.seq, source: event, job };
  }
  return null;
}
