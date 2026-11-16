import { and, eq, sql } from 'drizzle-orm';
import { OperatorQuestion } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, programOperatorCases } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { authorizeOperator, operatorRefused, type OperatorCaller } from './authorization.js';
import { escalateCase, syncOperatorCases } from './cases.js';
import { refreshCasePicture } from './pictures.js';
import { operatorTransaction } from './transactions.js';
import { agentParty } from '../events/parties.js';
import { operatorNotification } from './notifications.js';

export type ReportInput = { case: string; outcome: 'needs_owner' | 'failed' | 'denied'; text: string };

export async function reportOperatorCase(ctx: Ctx, caller: OperatorCaller, input: ReportInput): Promise<{ outcome: string; case: string; pictureId: string | null }> {
  const checked = await authorizeOperator(ctx, caller, input.case);
  if (checked.row.escalationJobId) return { outcome: checked.row.resolution!.outcome, case: checked.row.id, pictureId: checked.row.pictureId };
  if (checked.row.status === 'open') {
    try { await refreshCasePicture(ctx, checked.row); }
    catch { /* The last picture remains useful if the program or its node has just gone away. */ }
  }
  const result = await operatorTransaction(ctx, (tx, inside) => recordReport(tx, inside, caller, input, checked.target.id));
  await syncOperatorCases(ctx, result.agentId);
  return { outcome: result.resolution?.outcome ?? result.status, case: result.id, pictureId: result.pictureId };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function recordReport(tx: Tx, inside: Ctx, caller: OperatorCaller, input: ReportInput, targetId: string) {
  await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, targetId)).for('update');
  const current = await authorizeOperator(inside, caller, input.case, undefined, true);
  if (current.row.escalationJobId) return current.row;
  const decision = input.outcome === 'denied' ? await deniedDecision(inside, caller, current.row) : null;
  if (input.outcome === 'denied' && !decision) throw operatorRefused();
  const resolution = { outcome: input.outcome, text: input.text, image: current.row.pictureId, actor: await agentParty(inside, caller.companyId, current.me.id), ...(decision ? { question: decision.question } : {}) };
  await logTurnFact(inside, current.job, `${current.me.name} reported ${input.outcome}: ${input.text}`, { notification: await operatorNotification(inside, current.job), actor: resolution.actor, from: 'agent', by: current.me.id, name: current.me.name, operatorReport: { case: current.row.id, ...resolution } });
  await escalateCase(inside, current.row, input.outcome, new Date(), resolution);
  return (await tx.select().from(programOperatorCases).where(eq(programOperatorCases.id, current.row.id)))[0]!;
}

async function deniedDecision(ctx: Ctx, caller: OperatorCaller, row: typeof programOperatorCases.$inferSelect) {
  const [fact] = await ctx.db.select({ data: agentEvents.data }).from(agentEvents).where(and(eq(agentEvents.companyId, caller.companyId), eq(agentEvents.jobId, row.jobId), sql`${agentEvents.data}->'operatorAction'->>'case' = ${row.id}`, sql`${agentEvents.data}->'operatorAction'->>'operatorJobId' = ${caller.id}`, sql`${agentEvents.data}->'operatorAction'->'actor'->>'id' = ${caller.agentId}`, sql`${agentEvents.data}->'operatorAction'->>'decision' = 'denied'`, sql`${agentEvents.data}->'operatorAction'->>'result' = 'applied'`)).limit(1);
  const data = fact?.data as { operatorAction?: unknown } | undefined;
  const parsed = z.object({ key: z.literal('Enter'), decision: z.literal('denied'), permissionDecision: z.literal(true), question: OperatorQuestion.refine(question => question.kind === 'permission') }).safeParse(data?.operatorAction);
  return parsed.success && row.evidence.some(e => e.reason === 'question_waiting' && e.evidenceKey === parsed.data.question.id) ? parsed.data : null;
}
