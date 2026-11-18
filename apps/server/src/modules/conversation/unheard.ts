import type { ProgramNodeMessage } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { sameNode, type NodeIdentity } from '../nodes/hub.js';
import { jobsOf } from '../nodes/jobs.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { withInputLock } from './decision-context.js';
import { insertTurn, pump } from './queue.js';
import { nodeOfAgent } from './placement.js';
import { onAgent } from './line.js';
import { repeatedTurn, UNHEARD_NOTE, wordsForTurn } from './turn-words.js';
import { requeueOperatorWords } from '../program-operator/requeue.js';

type Unheard = Extract<ProgramNodeMessage, { type: 'agent.unheard' }>;
type Job = typeof jobs.$inferSelect;

function storeUnheard(ctx: Ctx, companyId: string, agentId: string, text: string, original: Job | undefined): Promise<string> {
  return withInputLock(ctx, agentId, async () => {
    const [source] = original ? await wordsForTurn(ctx, agentId, original.id, text) : [];
    return insertTurn(ctx, { companyId, agentId, prompt: text, ...(await repeatedTurn(ctx, original, source || null, original?.id)) });
  });
}

function recordUnheard(ctx: Ctx, agentId: string, job: Job, now: Date): Promise<unknown> {
  return onAgent(ctx, agentId, () => logTurnFact(ctx, job, UNHEARD_NOTE, { unheardAt: now.toISOString() }));
}

async function repeatWords(ctx: Ctx, { agent, original }: NonNullable<Awaited<ReturnType<typeof wordsFrom>>>, text: string, now: Date): Promise<void> {
  const next = await storeUnheard(ctx, agent.companyId, agent.id, text, original);
  const [job] = original ? [original] : await ctx.db.select().from(jobs).where(eq(jobs.id, next));
  await recordUnheard(ctx, agent.id, job!, now);
  await pump(ctx, agent.id);
}

/* Words that were already sent keep their sender, and wait for the next turn instead of trying live again. Words with a
   delivery go back by that delivery. */
export async function unheard(ctx: Ctx, node: NodeIdentity, msg: Unheard, now: Date): Promise<void> {
  const received = await wordsFrom(ctx, node, msg);
  if (!received || (await requeueOperatorWords(ctx, node, msg, now))) return;
  await repeatWords(ctx, received, msg.text, now);
}

/* The agent these words are of, and the turn they name, if this node runs them. */
export async function wordsFrom(ctx: Ctx, node: NodeIdentity, msg: Pick<Unheard, 'agentKey' | 'jobId'>) {
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
