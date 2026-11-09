import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OperatorError, OperatorRecoveryState } from '@hornhoof/protocol/program-operator';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, programOperatorCases } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { liveSubscription } from '../conversation/queue.js';
import { agentParty } from '../events/parties.js';
import { logTurnFact } from '../tasks/turn-log.js';
import { operatorRefused, type OperatorCaller } from './authorization.js';
import { syncOperatorCases } from './cases.js';
import { continueRecovery, runsATurn } from './recovery.js';
import { requestRecoveryState } from './rpc.js';
import { operatorTransaction } from './transactions.js';

/* The reliability engineer and the head of Operations: the people the five-minute watch calls. */
export const RELEASE_ROLES = ['OPS-FIX', 'OPS-HEAD'];
const RELEASE_ROLE_KIND: Record<string, 'worker' | 'head'> = { 'OPS-FIX': 'worker', 'OPS-HEAD': 'head' };

type Agent = typeof agents.$inferSelect;
type Case = typeof programOperatorCases.$inferSelect;
export type ReleaseInput = { case: string; reason: string };
type Refusal = OperatorError | 'no_plan';
export type ReleaseResult = { result: 'released'; continuation: string | null } | { result: 'no_hold'; status: Case['status']; continuation: string | null } | { result: 'refused'; reason: Refusal };

/* The advertised role is no authority: the current employee, department and running turn are. */
async function authorizeRelease(ctx: Ctx, caller: OperatorCaller): Promise<Agent> {
  const [found] = await ctx.db.select({ me: agents, department: departments }).from(agents)
    .innerJoin(jobs, eq(jobs.id, caller.id)).innerJoin(departments, eq(departments.id, agents.departmentId))
    .where(and(eq(agents.id, caller.agentId), eq(agents.companyId, caller.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt), eq(jobs.agentId, agents.id), eq(jobs.companyId, caller.companyId), eq(jobs.status, 'running'), eq(departments.companyId, caller.companyId)));
  if (!found || !found.me.roleKey || RELEASE_ROLE_KIND[found.me.roleKey] !== found.me.kind || !await inOperations(ctx, found.department)) throw operatorRefused();
  return found.me;
}

async function inOperations(ctx: Ctx, department: typeof departments.$inferSelect): Promise<boolean> {
  if (department.templateKey === 'operations') return true;
  const [parent] = department.parentId ? await ctx.db.select().from(departments).where(eq(departments.id, department.parentId)) : [];
  return parent?.templateKey === 'operations';
}

/* Only what the node sees right now counts; the database may be behind what the program does. */
function refusalOf(state: OperatorRecoveryState | null): OperatorError | null {
  if (!state) return 'node_unavailable';
  if (state.program === 'gone') return null;
  if (state.wait === 'protected') return 'protected_screen';
  if (state.wait) return 'input_not_proven';
  if (state.runningTool || state.retrying || state.busy) return 'program_busy';
  /* Hornhoof's own words that never went are erased by the saved words, which go in once in their place. */
  return state.input === 'empty' || state.input === 'hornhoof' ? null : 'input_not_proven';
}

const noHold = (row: Case): ReleaseResult => ({ result: 'no_hold', status: row.status, continuation: row.continuationJobId });

/* A case of this company, on an agent still here and not the caller itself. */
async function caseToRelease(ctx: Ctx, me: Agent, id: string): Promise<Case> {
  const [held] = await ctx.db.select({ row: programOperatorCases }).from(programOperatorCases).innerJoin(agents, eq(agents.id, programOperatorCases.agentId)).where(and(eq(programOperatorCases.id, id), eq(programOperatorCases.companyId, me.companyId), isNull(agents.removedAt)));
  if (!held || held.row.agentId === me.id) throw operatorRefused();
  return held.row;
}

export async function releaseRecoveryHold(ctx: Ctx, caller: OperatorCaller, input: ReleaseInput): Promise<ReleaseResult> {
  const me = await authorizeRelease(ctx, caller);
  const found = await caseToRelease(ctx, me, input.case);
  if (!found.recoveryHold) return noHold(found);
  const state = await requestRecoveryState(ctx, found);
  const result = await operatorTransaction(ctx, async (tx, inside) => {
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, found.agentId)).for('update');
    const [row] = await tx.select().from(programOperatorCases).where(eq(programOperatorCases.id, found.id)).for('update');
    return row?.recoveryHold ? decide(inside, me, row, input.reason, state) : noHold(row ?? found);
  });
  await syncOperatorCases(ctx, found.agentId);
  return result;
}

async function refusalNow(ctx: Ctx, row: Case, state: OperatorRecoveryState | null): Promise<Refusal | null> {
  const seen = refusalOf(state);
  if (seen) return seen;
  if (await runsATurn(ctx, row.agentId)) return 'program_busy';
  return await liveSubscription(ctx, row.agentId) ? null : 'no_plan';
}

async function decide(ctx: Ctx, me: Agent, row: Case, reason: string, state: OperatorRecoveryState | null): Promise<ReleaseResult> {
  const refusal = await refusalNow(ctx, row, state);
  if (refusal) return refused(ctx, me, row, reason, state, refusal);
  const actor = await agentParty(ctx, row.companyId, me.id);
  await continueRecovery(ctx, row, { outcome: 'released', text: `${me.name} of Operations released the hold; the original words continue once.`, actor });
  const [after] = await ctx.db.select().from(programOperatorCases).where(eq(programOperatorCases.id, row.id));
  if (after!.recoveryHold) return refused(ctx, me, row, reason, state, 'program_busy');
  const released = { result: 'released' as const, continuation: after!.continuationJobId };
  await audit(ctx, me, row, reason, state, released, `${me.name} of Operations released the recovery hold: ${reason}`);
  return released;
}

async function refused(ctx: Ctx, me: Agent, row: Case, reason: string, state: OperatorRecoveryState | null, refusal: Refusal): Promise<ReleaseResult> {
  await audit(ctx, me, row, reason, state, { result: 'refused', refusal }, `${me.name} of Operations tried to release the recovery hold, refused (${refusal}): ${reason}`);
  return { result: 'refused', reason: refusal };
}

const whatTheNodeSaw = (row: Case, state: OperatorRecoveryState | null) => state
  ? { instance: state.current ?? row.instance, generation: state.generation, program: state.program, input: state.input, wait: state.wait }
  : { instance: row.instance, generation: null, program: null, input: null, wait: null };

/* Who, when, why and what, with what the node saw then, in the conversation of the turn on hold. */
async function audit(ctx: Ctx, me: Agent, row: Case, reason: string, state: OperatorRecoveryState | null, outcome: Record<string, unknown>, text: string): Promise<void> {
  const [job] = await ctx.db.select().from(jobs).where(eq(jobs.id, row.jobId));
  await logTurnFact(ctx, job!, text, { operatorRecovery: row.id, notification: { source: 'program_operator', tasks: [] }, recoveryRelease: {
    actor: { id: me.id, name: me.name, role: me.roleKey }, reason, at: new Date().toISOString(), action: 'release_and_deliver', case: row.id, job: row.jobId,
    ...whatTheNodeSaw(row, state), ...outcome,
  } });
}

const text = (value: unknown, isError = false) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError } : {}) });

export function registerReleaseTool(server: McpServer, ctx: Ctx, caller: OperatorCaller): void {
  server.registerTool('program_recovery_release', {
    description: "Release one program operator case's recovery hold and deliver the agent's saved words once. Hornhoof asks the node what the program shows now and refuses while it asks a question, runs a tool, retries or holds other words, which stay with its owner, or when the agent has no plan to run them. Say why: the reason goes in the turn's log with your name. Repeating it changes nothing.",
    inputSchema: { case: z.uuid(), reason: z.string().trim().min(1).max(500) },
  }, async input => {
    try { return text(await releaseRecoveryHold(ctx, caller, input)); }
    catch (error) { if (error instanceof ApiError) return text(error.message, true); throw error; }
  });
}
