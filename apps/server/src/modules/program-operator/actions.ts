import { createHash, randomUUID } from 'node:crypto';
import { OPERATOR_MAX_KEYS, OPERATOR_SNAPSHOT_MS, OperatorKey, OperatorQuestion, type OperatorError } from '@hornhoof/protocol/program-operator';
import { and, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentEvents, agents, jobs, programOperatorActions, programOperatorCases } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentParty, MessageEnvelopeSchema } from '../events/parties.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { authorizeOperator, operatorRefused, type OperatorCaller } from './authorization.js';
import { operatorCaseMode } from './cases.js';
import { requestOperatorKey } from './rpc.js';
import { operatorTransaction } from './transactions.js';
import { operatorNotification } from './notifications.js';

export type KeyInput = { employee: string; case: string; snapshot: string; key: string; reason: string; action?: string; decision?: 'allowed' | 'denied' };
type Action = typeof programOperatorActions.$inferSelect;
const Decision = z.object({ question: OperatorQuestion.optional(), decision: z.enum(['allowed', 'denied']).optional(), requestedDecision: z.enum(['allowed', 'denied']).optional(), permissionDecision: z.boolean().optional(), recordedActor: MessageEnvelopeSchema.shape.from.optional() });
type Decision = z.infer<typeof Decision>;
type Outcome = { action: string; result: Action['result']; reason: OperatorError | null };
const outcome = (action: Action): Outcome => ({ action: action.id, result: action.result, reason: action.error });

/* The database intent commits before a byte goes to the node. Its action id is never retried by this server. */
export async function sendProgramKey(ctx: Ctx, caller: OperatorCaller, input: KeyInput): Promise<Outcome> {
  try { return await performKey(ctx, caller, input); }
  catch (error) {
    if (error instanceof ApiError) await logAuthorizationRefusal(ctx, caller, input);
    throw error;
  }
}

async function performKey(ctx: Ctx, caller: OperatorCaller, input: KeyInput): Promise<Outcome> {
  const actionId = input.action ?? randomUUID();
  const digest = createHash('sha256').update(JSON.stringify({ caller: caller.id, agent: caller.agentId, company: caller.companyId, case: input.case, employee: input.employee, snapshot: input.snapshot, key: input.key, reason: input.reason, decision: input.decision ?? null, action: actionId })).digest('hex');
  const reserved = await reserveAction(ctx, caller, input, actionId, digest);
  if (reserved.old) return cachedAction(ctx, reserved.action, reserved.decision);
  if (reserved.refusal) return completeAction(ctx, reserved.action, 'refused', reserved.refusal, reserved.decision);
  return dispatchAction(ctx, caller, input, reserved);
}

async function dispatchAction(ctx: Ctx, caller: OperatorCaller, input: KeyInput, reserved: Awaited<ReturnType<typeof reserveAction>>): Promise<Outcome> {
  const key = OperatorKey.parse(input.key);
  let reply;
  try {
    reply = await operatorTransaction(ctx, async (_tx, inside) => {
      await authorizeOperator(inside, caller, input.case, input.employee, false, true);
      return requestOperatorKey(inside, reserved.target, { action: reserved.action.id, snapshot: input.snapshot, generation: reserved.action.generation, key });
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return completeAction(ctx, reserved.action, 'refused', 'operator_forbidden', reserved.decision);
  }
  return completeAction(ctx, reserved.action, reply?.result ?? 'unknown', reply?.reason ?? (reply ? null : 'action_unknown'), reserved.decision);
}

async function reserveAction(ctx: Ctx, caller: OperatorCaller, input: KeyInput, id: string, digest: string) {
  return operatorTransaction(ctx, async (tx, inside) => {
    const checked = await authorizeOperator(inside, caller, input.case, input.employee, true);
    const [old] = await tx.select().from(programOperatorActions).where(eq(programOperatorActions.id, id));
    if (old) {
      if (old.operatorJobId !== caller.id || old.digest !== digest) throw operatorRefused();
      return { action: old, old: true, refusal: null, target: checked.row, decision: await originalDecision(inside, old) };
    }
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, checked.target.id)).for('update');
    const fresh = await authorizeOperator(inside, caller, input.case, input.employee, false, true);
    const mode = await operatorCaseMode(inside, fresh.row);
    const [used] = await tx.select({ n: count() }).from(programOperatorActions).where(eq(programOperatorActions.caseId, fresh.row.id));
    const snapshot = fresh.row.snapshot;
    const refusal = keyRefusal(input, mode, snapshot, used?.n ?? 0);
    const decision = await intentDecision(inside, caller, input, mode, refusal);
    const [action] = await tx.insert(programOperatorActions).values({ id, digest, companyId: caller.companyId, caseId: input.case, operatorAgentId: fresh.me.id, operatorJobId: caller.id, actorName: fresh.me.name, agentId: fresh.target.id, jobId: fresh.job.id, instance: fresh.row.instance, snapshot: input.snapshot, generation: snapshot?.generation ?? 0, key: input.key.slice(0, 40), reason: input.reason.slice(0, 1000), result: 'requested' }).returning();
    await logAction(inside, action!, decision);
    await tx.update(programOperatorCases).set({ snapshot: null }).where(eq(programOperatorCases.id, fresh.row.id));
    return { action: action!, old: false, refusal, target: fresh.row, decision };
  });
}

async function intentDecision(ctx: Ctx, caller: OperatorCaller, input: KeyInput, mode: Awaited<ReturnType<typeof operatorCaseMode>>, refusal: OperatorError | null): Promise<Decision> {
  return { question: mode.question, requestedDecision: input.decision, recordedActor: await agentParty(ctx, caller.companyId, caller.agentId), ...(input.decision && !refusal ? { decision: input.decision, permissionDecision: true } : {}) };
}

function keyRefusal(input: KeyInput, mode: { reason: string; readOnly: boolean; question?: OperatorQuestion }, snapshot: (typeof programOperatorCases.$inferSelect)['snapshot'], used: number): OperatorError | null {
  if (!validKeyIntent(input, mode, used) || !validPermissionDecision(input, mode)) return 'operator_forbidden';
  if (!snapshot || !freshSnapshot(snapshot, input.snapshot)) return 'snapshot_stale';
  if (!snapshot.keysAllowed) return 'input_not_proven';
  if (missingPermissionDecision(input, mode)) return 'input_not_proven';
  return null;
}

function missingPermissionDecision(input: KeyInput, mode: { question?: OperatorQuestion }): boolean {
  return mode.question?.kind === 'permission' && input.key === 'Enter' && !input.decision;
}

function freshSnapshot(snapshot: NonNullable<(typeof programOperatorCases.$inferSelect)['snapshot']>, token: string): boolean {
  return snapshot.token === token && !(Date.now() - +new Date(snapshot.at) >= OPERATOR_SNAPSHOT_MS);
}

function validKeyIntent(input: KeyInput, mode: { readOnly: boolean }, used: number): boolean {
  return OperatorKey.safeParse(input.key).success && Boolean(input.reason.trim()) && !mode.readOnly && used < OPERATOR_MAX_KEYS;
}

function validPermissionDecision(input: KeyInput, mode: { reason: string; question?: OperatorQuestion }): boolean {
  return !input.decision || (mode.reason === 'question_waiting' && mode.question?.kind === 'permission' && input.key === 'Enter');
}

async function cachedAction(ctx: Ctx, action: Action, decision: Decision): Promise<Outcome> {
  if (action.result === 'requested') return completeAction(ctx, action, 'unknown', 'action_unknown', decision);
  return outcome(action);
}

async function completeAction(ctx: Ctx, action: Action, result: Action['result'], error: OperatorError | null, decision: Decision): Promise<Outcome> {
  return operatorTransaction(ctx, async (tx, inside) => {
    const [updated] = await tx.update(programOperatorActions).set({ result, error, completedAt: new Date() }).where(and(eq(programOperatorActions.id, action.id), eq(programOperatorActions.operatorJobId, action.operatorJobId), eq(programOperatorActions.result, 'requested'))).returning();
    if (!updated) {
      const [stored] = await tx.select().from(programOperatorActions).where(eq(programOperatorActions.id, action.id));
      return outcome(stored!);
    }
    await logAction(inside, updated!, decision);
    return outcome(updated!);
  });
}

async function logAction(ctx: Ctx, action: Action, decision: Decision): Promise<void> {
  const operatorAction = { id: action.id, case: action.caseId, operatorJobId: action.operatorJobId, targetJobId: action.jobId, instance: action.instance, snapshot: action.snapshot, at: action.completedAt ?? action.requestedAt, actor: { id: action.operatorAgentId, name: action.actorName }, key: action.key, reason: action.reason, result: action.result, error: action.error, ...decision };
  const choice = decision.decision ? ` Decision: ${decision.decision}. Request: ${decision.question?.text ?? 'unavailable'}.` : '';
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, action.jobId));
  const actor = decision.recordedActor ?? { ...await agentParty(ctx, action.companyId, action.operatorAgentId), name: action.actorName };
  await logTurnFact(ctx, job!, `${action.actorName}, key ${action.key}: ${action.result}${action.error ? ` (${action.error})` : ''}. Reason: ${action.reason}.${choice}`, { notification: await operatorNotification(ctx, job!), actor, from: 'agent', by: action.operatorAgentId, name: action.actorName, operatorAction });
}

async function originalDecision(ctx: Ctx, action: Action): Promise<Decision> {
  const [intent] = await ctx.db.select({ data: agentEvents.data }).from(agentEvents).where(and(eq(agentEvents.jobId, action.jobId), sql`${agentEvents.data}->'operatorAction'->>'id' = ${action.id}`, sql`${agentEvents.data}->'operatorAction'->>'result' = 'requested'`)).limit(1);
  const data = intent?.data as { operatorAction?: unknown } | undefined;
  return Decision.parse(data?.operatorAction ?? {});
}

async function logAuthorizationRefusal(ctx: Ctx, caller: OperatorCaller, input: KeyInput): Promise<void> {
  const [authenticated] = await ctx.db.select({ job: jobs, agent: agents }).from(jobs).innerJoin(agents, eq(agents.id, jobs.agentId)).where(and(eq(jobs.id, caller.id), eq(jobs.companyId, caller.companyId), eq(agents.companyId, caller.companyId), eq(agents.id, caller.agentId), eq(jobs.status, 'running')));
  if (!authenticated) return;
  const actor = { id: authenticated.agent.id, name: authenticated.agent.name };
  await logTurnFact(ctx, authenticated.job, `Program key refused: ${input.key.slice(0, 40)}. The operator authorization is no longer valid.`, { notification: { source: 'program_operator', tasks: [] }, operatorRefusal: { actor, employee: input.employee, case: input.case, action: input.action, key: input.key.slice(0, 40), reason: input.reason.slice(0, 1000), result: 'refused' } });
}
