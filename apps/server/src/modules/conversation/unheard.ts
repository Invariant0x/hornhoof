import type { NodeMessage } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, subscriptions } from '../../db/schema.js';
import { sameNode, type NodeIdentity } from '../nodes/hub.js';
import { jobsOf } from '../nodes/messages.js';
import { notifyFailure } from '../tasks/failures.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { enqueueTurn, nodeOfAgent, onAgent, pump } from './queue.js';
import { repeatedTurn, UNHEARD_NOTE, wordsForTurn, type TurnWords } from './turn-words.js';

const HOUR_MS = 3_600_000;
type Job = typeof jobs.$inferSelect;

/* Words that were already sent keep their sender, and wait for the next turn instead of trying live again. */
export async function unheard(ctx: Ctx, node: NodeIdentity, msg: Extract<NodeMessage, { type: 'agent.unheard' }>, now: Date): Promise<void> {
  const received = await unheardFrom(ctx, node, msg);
  if (!received) return;
  const { agent, original } = received;
  const source = original ? (await wordsForTurn(ctx, agent.id, original.id, msg.text))[0] ?? null : null;
  const next = await repeatWords(ctx, agent, original, source, msg.text);
  const [job] = original ? [original] : await ctx.db.select().from(jobs).where(eq(jobs.id, next));
  await onAgent(ctx, agent.id, async () => {
    await logTurnFact(ctx, job!, UNHEARD_NOTE, { unheardAt: now.toISOString() });
    await repeatedUnheard(ctx, job!, agent.name, now);
  });
  await pump(ctx, agent.id);
}

async function unheardFrom(ctx: Ctx, node: NodeIdentity, msg: Extract<NodeMessage, { type: 'agent.unheard' }>) {
  if (!z.uuid().safeParse(msg.agentKey).success) return null;
  const origin = await wordsOrigin(ctx, node, msg.agentKey, msg.jobId);
  if (!origin) return null;
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, msg.agentKey), isNull(agents.removedAt)));
  if (!agent) return null;
  return { agent, ...origin };
}

async function wordsOrigin(ctx: Ctx, node: NodeIdentity, agentId: string, jobId: string | null) {
  if (jobId === null) {
    const owner = await nodeOfAgent(ctx, agentId);
    return owner && sameNode(owner, node) ? { original: undefined } : null;
  }
  if (!z.uuid().safeParse(jobId).success) return null;
  const [original] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.agentId, agentId), ne(jobs.status, 'queued'), jobsOf(node, ctx)));
  return original ? { original } : null;
}

async function repeatWords(ctx: Ctx, agent: { id: string; companyId: string }, original: Job | undefined, source: TurnWords | null, text: string): Promise<string> {
  return enqueueTurn(ctx, { companyId: agent.companyId, agentId: agent.id, prompt: text, ...await repeatedTurn(ctx, original, source, original?.id) });
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
