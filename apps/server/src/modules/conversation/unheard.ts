import type { ProgramNodeMessage } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { sameNode, type NodeIdentity } from '../nodes/hub.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { enqueueTurn, nodeOfAgent, onAgent, pump, settleWords } from './queue.js';
import { repeatedTurn, UNHEARD_NOTE, wordsForTurn } from './turn-words.js';
import { requeueOperatorWords } from '../program-operator/requeue.js';

/* Words that were already sent keep their sender, and wait for the next turn instead of trying live again. */
export async function unheard(ctx: Ctx, node: NodeIdentity, msg: Extract<ProgramNodeMessage, { type: 'agent.unheard' }>, now: Date): Promise<void> {
  if (!z.uuid().safeParse(msg.agentKey).success) return;
  const owner = await nodeOfAgent(ctx, msg.agentKey);
  if (!owner || !sameNode(owner, node)) return;
  if (await requeueOperatorWords(ctx, node, msg, now)) return;
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, msg.agentKey), isNull(agents.removedAt)));
  if (!agent) return;
  const [original] = msg.jobId ? await ctx.db.select().from(jobs).where(and(eq(jobs.id, msg.jobId), eq(jobs.agentId, agent.id))) : [];
  if (msg.jobId && !original) return;
  const source = original ? (await wordsForTurn(ctx, agent.id, original.id, msg.text))[0] ?? null : null;
  const next = await enqueueTurn(ctx, { companyId: agent.companyId, agentId: agent.id, prompt: msg.text, ...await repeatedTurn(ctx, original, source) });
  const [job] = original ? [original] : await ctx.db.select().from(jobs).where(eq(jobs.id, next));
  await onAgent(ctx, agent.id, async () => {
    await logTurnFact(ctx, job!, UNHEARD_NOTE, { unheardAt: now.toISOString() });
    if (original) settleWords(ctx, agent.id, original.id, original.status === 'running');
  });
  await pump(ctx, agent.id);
}
