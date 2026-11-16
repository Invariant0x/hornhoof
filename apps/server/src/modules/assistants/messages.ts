import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { agentEvents, assistantReplies } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import type { AgentRow } from '../agents/find.js';
import { writeToAgent } from '../conversation/routes.js';

/* The newest event of the agent so far: what it says after it answers what comes now. */
async function lastSeq(ctx: Pick<Ctx, 'db'>, agentId: string): Promise<number> {
  const [last] = await ctx.db.select(only(agentEvents, 'seq')).from(agentEvents).where(eq(agentEvents.agentId, agentId)).orderBy(desc(agentEvents.seq)).limit(1);
  return last?.seq ?? 0;
}

/* The assistant's words to an agent, as its owner's, through the same way a person's words and files from the window go.
   What the agent says from that message on, in the turn it went into, is collected for the assistant. fresh: the program's
   whole conversation, for its own agent. files: the ids the program sent its files under, for this agent. byOwnAgent names
   the sender, not the answering agent. Returns the message's id. */
export async function sendForOwner(ctx: Ctx, me: Person, agent: AgentRow, sent: { text: string; fresh?: string; files?: string[]; byOwnAgent?: boolean }): Promise<string> {
  const { text, fresh, files = [], byOwnAgent = false } = sent;
  const messageId = randomUUID();
  const before = await lastSeq(ctx, agent.id);
  const jobId = await writeToAgent(ctx, me, agent, { text, pictures: files, assistant: { message: messageId, own: agent.kind === 'assistant', ...(fresh ? { fresh } : {}) } });
  const [said] = await ctx.db
    .select(only(agentEvents, 'seq'))
    .from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data}->'assistant'->>'message' = ${messageId}`))
    .orderBy(desc(agentEvents.seq))
    .limit(1);
  await ctx.db.insert(assistantReplies).values({ companyId: me.companyId, assistantId: me.assistant!.id, agentId: agent.id, messageId, jobId, byOwnAgent, afterSeq: said?.seq ?? before });
  ctx.assistants.collect(me.companyId);
  return messageId;
}
