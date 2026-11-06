import { IntegrationTarget, ProductCommitSha, type WorkspaceProblem } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { stagingPlans, tasks, testParts, testRuns, turns } from '../../db/schema.js';
import { evaluateStagingPin } from './staging-pin.js';

export interface StagingPrivateContext { db: Db; companyId: string }
export interface StagingPlanQuery { repositoryId: string; turnId: string | null; urgentLaneId?: string }
export interface RegisteredStagingPlan {
  version: 1; planId: string; generation: number; companyId: string; repositoryId: string; turnId: string;
  baseRef: string; baseSha: string; requiredIntegrations: [IntegrationTarget, ...IntegrationTarget[]];
  health: { checkedCommitSha: string; runId: string; partIds: [string, ...string[]] };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Plan = typeof stagingPlans.$inferSelect;
const Query = z.strictObject({ repositoryId: z.uuid(), turnId: z.uuid().nullable(), urgentLaneId: z.uuid().optional() });
const missing = (): WorkspaceProblem => ({ code: 'integration_plan_missing', retryable: true });
const unknownHealth = (): WorkspaceProblem => ({ code: 'turn_health_unknown', retryable: true });

function normalTargets(plan: Plan, turnNumber: number): [IntegrationTarget, ...IntegrationTarget[]] | null {
  const targets = z.array(IntegrationTarget).length(1).safeParse(plan.requiredIntegrations);
  const ref = `turn-${turnNumber}`;
  if (!targets.success || !ProductCommitSha.safeParse(plan.baseSha).success || plan.baseRef !== ref) return null;
  const target = targets.data[0]!;
  return target.kind === 'turn' && target.ref === ref ? [target] : null;
}

async function nativeHealth(tx: Tx, plan: Plan): Promise<RegisteredStagingPlan['health'] | WorkspaceProblem> {
  if (!plan.healthRunId) return unknownHealth();
  const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.id, plan.healthRunId), eq(testRuns.companyId, plan.companyId)));
  if (!run || !run.finishedAt) return unknownHealth();
  const [task] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.companyId, plan.companyId), eq(tasks.turnId, plan.turnId)));
  if (!task) return unknownHealth();
  const parts = await tx.select().from(testParts).where(eq(testParts.runId, run.id));
  if (parts.some(part => !part.finishedAt)) return unknownHealth();
  const proof = evaluateStagingPin({ companyId: plan.companyId, runId: run.id, taskId: run.taskId,
    jobId: run.jobId, agentId: run.agentId, commitSha: plan.baseSha, parts: run.parts }, run, parts);
  if (proof.status === 'failed_unattributed') return { code: 'turn_branch_red', retryable: true };
  if (proof.status !== 'passed') return unknownHealth();
  return { checkedCommitSha: plan.baseSha, runId: run.id, partIds: [proof.partIds[0]!, ...proof.partIds.slice(1)] };
}

/* Reads registered rows only. Root registration and protected native dispatch remain separate writers. */
export async function resolveRegisteredStagingPlan(ctx: StagingPrivateContext, query: StagingPlanQuery): Promise<RegisteredStagingPlan | WorkspaceProblem> {
  const parsed = Query.safeParse(query), company = z.uuid().safeParse(ctx.companyId);
  if (!parsed.success || !company.success) return { code: 'binding_stale', retryable: false };
  const { repositoryId, turnId, urgentLaneId } = parsed.data;
  if (turnId === null || urgentLaneId !== undefined) return missing();
  return ctx.db.transaction(async (tx): Promise<RegisteredStagingPlan | WorkspaceProblem> => {
    const roots = await tx.select({ plan: stagingPlans, turnNumber: turns.number }).from(stagingPlans)
      .innerJoin(turns, and(eq(turns.id, stagingPlans.turnId), eq(turns.companyId, stagingPlans.companyId)))
      .where(and(eq(stagingPlans.companyId, company.data), eq(stagingPlans.repositoryId, repositoryId),
        eq(stagingPlans.turnId, turnId), eq(stagingPlans.isCurrent, true), eq(stagingPlans.enabled, true), eq(turns.status, 'open'))).for('share');
    if (roots.length !== 1) return missing();
    const { plan, turnNumber } = roots[0]!, targets = normalTargets(plan, turnNumber);
    if (!targets) return missing();
    const health = await nativeHealth(tx, plan);
    if ('code' in health) return health;
    return { version: 1, planId: plan.id, generation: plan.generation, companyId: plan.companyId,
      repositoryId: plan.repositoryId, turnId: plan.turnId, baseRef: plan.baseRef, baseSha: plan.baseSha, requiredIntegrations: targets, health };
  }, { isolationLevel: 'repeatable read' });
}
