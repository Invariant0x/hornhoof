import { and, eq, sql } from 'drizzle-orm';
import { OperatorQuestion, type ProgramView } from '@hornhoof/protocol/program-operator';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, programOperatorCases } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { authorizeOperator, operatorRefused, type OperatorCaller } from './authorization.js';
import { escalateCase, resolveCase, syncOperatorCases, takesLateDenial } from './cases.js';
import { refreshCasePicture } from './pictures.js';
import { operatorTransaction } from './transactions.js';
import { agentParty } from '../events/parties.js';
import { operatorNotification } from './notifications.js';

type Case = typeof programOperatorCases.$inferSelect;
export type ReportInput = { case: string; outcome: 'cleared' | 'needs_owner' | 'failed' | 'denied'; text: string };
type ReportResult = { outcome: string; case: string; pictureId: string | null; closed?: string };

export async function reportOperatorCase(ctx: Ctx, caller: OperatorCaller, input: ReportInput): Promise<ReportResult> {
  const earlier = await closedBefore(ctx, caller, input);
  if (earlier) return closedAnswer(earlier);
  const checked = await authorizeOperator(ctx, caller, input.case);
  if (checked.row.escalationJobId) return { outcome: checked.row.resolution!.outcome, case: checked.row.id, pictureId: checked.row.pictureId };
  /* The last picture remains useful if the program or its node has just gone away. */
  const seen = checked.row.status === 'open' ? await refreshCasePicture(ctx, checked.row).catch(() => null) : null;
  const result = await operatorTransaction(ctx, (tx, inside) => recordReport(tx, inside, caller, input, checked.target.id, seen));
  await syncOperatorCases(ctx, result.row.agentId);
  return result.closed ? closedAnswer(result.row) : { outcome: result.row.resolution?.outcome ?? result.row.status, case: result.row.id, pictureId: result.row.pictureId };
}

/* A case of this operator that closed by itself before the report came, from any turn of the operator's: the report changes
   nothing, and the answer says how the case closed. */
async function closedBefore(ctx: Ctx, caller: OperatorCaller, input: ReportInput): Promise<Case | null> {
  const [found] = await ctx.db.select({ row: programOperatorCases }).from(programOperatorCases)
    .innerJoin(jobs, and(eq(jobs.id, caller.id), eq(jobs.agentId, caller.agentId), eq(jobs.companyId, caller.companyId), eq(jobs.status, 'running')))
    .where(and(eq(programOperatorCases.id, input.case), eq(programOperatorCases.companyId, caller.companyId), eq(programOperatorCases.operatorAgentId, caller.agentId)));
  return found && alreadyClosed(found.row, input) ? found.row : null;
}

const alreadyClosed = (row: Case, input: ReportInput) => row.status === 'resolved' && !takesLateDenial(row, input.outcome);

function closedAnswer(row: Case): ReportResult {
  const outcome = row.resolution?.outcome ?? row.status;
  return { outcome, case: row.id, pictureId: row.pictureId, closed: `Case ${row.id} is already closed (${outcome}): ${row.resolution?.text ?? ''} Your report changes nothing and goes to no one.` };
}

/* cleared closes a case on what the program shows now: at work, asking nothing. */
function clearedRefusal(seen: ProgramView | null): ApiError | null {
  if (seen?.state === 'working' && !seen.question) return null;
  const shows = !seen ? 'no screen Hornhoof can read' : seen.question ? 'a question it waits on' : `the program ${seen.state}`;
  return new ApiError(409, 'conflict', `Not cleared: the program's fresh screen shows ${shows}. Clear what stops it and look again, or report failed with what the screen shows.`, 'agent_not_ready');
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function recordReport(tx: Tx, inside: Ctx, caller: OperatorCaller, input: ReportInput, targetId: string, seen: ProgramView | null): Promise<{ row: Case; closed: boolean }> {
  await tx.select(idOnly(agents)).from(agents).where(eq(agents.id, targetId)).for('update');
  const current = await authorizeOperator(inside, caller, input.case, undefined, true);
  if (current.row.escalationJobId) return { row: current.row, closed: false };
  if (alreadyClosed(current.row, input)) return { row: current.row, closed: true };
  const refusal = input.outcome === 'cleared' ? clearedRefusal(seen) : null;
  if (refusal) throw refusal;
  const decision = input.outcome === 'denied' ? await deniedDecision(inside, caller, current.row) : null;
  if (input.outcome === 'denied' && !decision) throw operatorRefused();
  const resolution = { outcome: input.outcome, text: input.text, image: current.row.pictureId, actor: await agentParty(inside, caller.companyId, current.me.id), ...(decision ? { question: decision.question } : {}) };
  await logTurnFact(inside, current.job, `${current.me.name} reported ${input.outcome}: ${input.text}`, { notification: await operatorNotification(inside, current.job), actor: resolution.actor, from: 'agent', by: current.me.id, name: current.me.name, operatorReport: { case: current.row.id, ...resolution } });
  if (input.outcome === 'cleared') await resolveCase(inside, current.row, resolution);
  else await escalateCase(inside, current.row, input.outcome, new Date(), resolution);
  return { row: (await tx.select().from(programOperatorCases).where(eq(programOperatorCases.id, current.row.id)))[0]!, closed: false };
}

async function deniedDecision(ctx: Ctx, caller: OperatorCaller, row: typeof programOperatorCases.$inferSelect) {
  const [fact] = await ctx.db.select(only(agentEvents, 'data')).from(agentEvents).where(and(eq(agentEvents.companyId, caller.companyId), eq(agentEvents.jobId, row.jobId), sql`${agentEvents.data}->'operatorAction'->>'case' = ${row.id}`, sql`${agentEvents.data}->'operatorAction'->>'operatorJobId' = ${caller.id}`, sql`${agentEvents.data}->'operatorAction'->'actor'->>'id' = ${caller.agentId}`, sql`${agentEvents.data}->'operatorAction'->>'decision' = 'denied'`, sql`${agentEvents.data}->'operatorAction'->>'result' = 'applied'`)).limit(1);
  const data = fact?.data as { operatorAction?: unknown } | undefined;
  const parsed = z.object({ key: z.literal('Enter'), decision: z.literal('denied'), permissionDecision: z.literal(true), question: OperatorQuestion.refine(question => question.kind === 'permission') }).safeParse(data?.operatorAction);
  return parsed.success && row.evidence.some(e => e.reason === 'question_waiting' && e.evidenceKey === parsed.data.question.id) ? parsed.data : null;
}
