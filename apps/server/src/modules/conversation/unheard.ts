import type { NodeMessage } from '@hornhoof/protocol';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, subscriptions } from '../../db/schema.js';
import { sameNode, type NodeIdentity } from '../nodes/hub.js';
import { notifyFailure } from '../tasks/failures.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { enqueueTurn, nodeOfAgent, onAgent, pump, settleWords } from './queue.js';
import { repeatedTurn, UNHEARD_NOTE, wordsForTurn } from './turn-words.js';

const HOUR_MS = 3_600_000;
type Job = typeof jobs.$inferSelect;

/* Words that were already sent keep their sender, and wait for the next turn instead of trying live again. */
export async function unheard(ctx: Ctx, node: NodeIdentity, msg: Extract<NodeMessage, { type: 'agent.unheard' }>, now: Date): Promise<void> {
  if (!z.uuid().safeParse(msg.agentKey).success) return;
  const owner = await nodeOfAgent(ctx, msg.agentKey);
  if (!owner || !sameNode(owner, node)) return;
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, msg.agentKey), isNull(agents.removedAt)));
  if (!agent) return;
  const [original] = msg.jobId ? await ctx.db.select().from(jobs).where(and(eq(jobs.id, msg.jobId), eq(jobs.agentId, agent.id))) : [];
  if (msg.jobId && !original) return;
  const source = original ? (await wordsForTurn(ctx, agent.id, original.id, msg.text))[0] ?? null : null;
  const next = await enqueueTurn(ctx, { companyId: agent.companyId, agentId: agent.id, prompt: msg.text, ...await repeatedTurn(ctx, original, source) });
  const [job] = original ? [original] : await ctx.db.select().from(jobs).where(eq(jobs.id, next));
  await onAgent(ctx, agent.id, async () => {
    await logTurnFact(ctx, job!, UNHEARD_NOTE, { unheardAt: now.toISOString() });
    await repeatedUnheard(ctx, job!, agent.name, now);
    if (original) settleWords(ctx, agent.id, original.id, original.status === 'running');
  });
  await pump(ctx, agent.id);
}

async function repeatedUnheard(ctx: Ctx, job: Job, name: string, now: Date): Promise<void> {
  const since = new Date(+now - HOUR_MS).toISOString();
  const where = and(eq(agentEvents.agentId, job.agentId!), sql`${agentEvents.data}->>'unheardAt' > ${since}`, sql`${agentEvents.data}->>'unheardAt' <= ${now.toISOString()}`);
  const entries = await ctx.db.select({ at: sql<string>`${agentEvents.data}->>'unheardAt'` }).from(agentEvents).where(where).orderBy(asc(agentEvents.seq));
  if (entries.length < 3) return;
  const [sent] = await ctx.db.select({ id: agentEvents.id }).from(agentEvents).where(and(eq(agentEvents.agentId, job.agentId!), sql`${agentEvents.data}->>'unheardAlarmAt' > ${since}`)).limit(1);
  if (sent) return;
  const [plan] = await ctx.db.select({ provider: subscriptions.provider }).from(subscriptions).where(eq(subscriptions.id, job.subscriptionId));
  const times = entries.slice(-3).map(entry => entry.at).join(', ');
  const text = `Hornhoof: ${name}'s program (${plan?.provider ?? 'unknown'}) did not take live words three times: ${times}. The words go with its next turn. Find why the program did not take them.`;
  const caseId = `unheard:${job.agentId}:${now.toISOString()}`;
  await logTurnFact(ctx, job, text, { unheardAlarmAt: now.toISOString() });
  await notifyFailure(ctx, job, text, caseId);
}
