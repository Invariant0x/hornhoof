import type { OperatorError, OperatorRecoveryState } from '@hornhoof/protocol/program-operator';
import { and, desc, eq, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, nodes, programOperatorCases, subscriptions } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { liveNode } from '../nodes/nodes.js';
import { requestRecoveryState } from './rpc.js';

type Case = typeof programOperatorCases.$inferSelect;

/* What reached a node: a turn that started there, runs there, or waits on a named node. */
const reachedNode = or(
  isNotNull(jobs.startedAt),
  eq(jobs.status, 'running'),
  and(eq(jobs.status, 'queued'), or(isNotNull(jobs.nodeId), isNotNull(jobs.builtinMachine))),
);

const noProgramState = (row: Case): OperatorRecoveryState => ({
  type: 'program.recovery_state',
  agentKey: row.agentId,
  jobId: row.jobId,
  instance: row.instance,
  request: '',
  program: 'gone',
  current: null,
  generation: 0,
  input: 'unknown',
  wait: null,
  runningTool: false,
  retrying: false,
  busy: false,
});

async function liveNodeOnPlan(ctx: Ctx, nodeId: string | null, subscriptionId: string): Promise<string | null> {
  if (!nodeId) return null;
  const [placed] = await ctx.db
    .select(idOnly(nodes))
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.subscriptionId, subscriptionId), liveNode))
    .limit(1);
  return placed?.id ?? null;
}

async function latestJobNodeOnPlan(ctx: Ctx, row: Case, subscriptionId: string): Promise<string | null> {
  const [lastJob] = await ctx.db
    .select({ nodeId: jobs.nodeId })
    .from(jobs)
    .where(and(eq(jobs.agentId, row.agentId), eq(jobs.companyId, row.companyId), eq(jobs.kind, 'conversation'), eq(jobs.subscriptionId, subscriptionId), isNotNull(jobs.nodeId), reachedNode))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return lastJob?.nodeId ?? null;
}

async function recoveryNodeId(ctx: Ctx, row: Case, subscriptionId: string, agentNodeId: string | null, samePlan: boolean): Promise<string | null> {
  const placed = await liveNodeOnPlan(ctx, agentNodeId, subscriptionId);
  if (placed && (!samePlan || placed !== row.nodeId)) return placed;
  const recent = await latestJobNodeOnPlan(ctx, row, subscriptionId);
  if (recent) return recent;
  return samePlan ? row.nodeId : null;
}

/* Ask the employee's current node rather than a stale case.nodeId left behind after a plan or node switch. */
export async function currentRecoveryState(ctx: Ctx, row: Case): Promise<OperatorRecoveryState | null> {
  const [current] = await ctx.db
    .select({ agentNodeId: agents.nodeId, subId: subscriptions.id, subKind: subscriptions.kind })
    .from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), isNull(subscriptions.removedAt)))
    .where(and(eq(agents.id, row.agentId), isNull(agents.removedAt)));
  if (!current || current.subKind !== 'personal') return noProgramState(row);
  const [caseJob] = await ctx.db.select({ subscriptionId: jobs.subscriptionId }).from(jobs).where(eq(jobs.id, row.jobId));
  const nodeId = await recoveryNodeId(ctx, row, current.subId, current.agentNodeId, current.subId === caseJob?.subscriptionId);
  return nodeId ? requestRecoveryState(ctx, { ...row, nodeId }) : noProgramState(row);
}

export function unavailableOperatorHold(row: Case): boolean {
  return row.recoveryHold && row.reason === 'assignment_unrecorded' && row.resolution?.outcome === 'operator_unavailable';
}

const screenBusy = (state: OperatorRecoveryState): boolean =>
  state.runningTool || state.retrying || state.busy;

const inputAllowed = (input: OperatorRecoveryState['input'], replaceHornhoofInput: boolean): boolean =>
  input === 'empty' || (replaceHornhoofInput && input === 'hornhoof');

/* Only what the node sees right now counts. Manual release can also replace Hornhoof's own unsent words. */
export function recoveryScreenRefusal(state: OperatorRecoveryState | null, replaceHornhoofInput = false): OperatorError | null {
  if (!state) return 'node_unavailable';
  if (state.program === 'gone') return null;
  if (state.wait === 'protected') return 'protected_screen';
  if (state.wait) return 'input_not_proven';
  if (screenBusy(state)) return 'program_busy';
  return inputAllowed(state.input, replaceHornhoofInput) ? null : 'input_not_proven';
}

export async function operatorRecoveryHolds(ctx: Ctx, agentId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.agentId, agentId));
}

export async function recoveryHolds(ctx: Ctx, scope: SQL): Promise<boolean> {
  const [held] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases).where(and(scope, eq(programOperatorCases.recoveryHold, true))).limit(1);
  return Boolean(held);
}
