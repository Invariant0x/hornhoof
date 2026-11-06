import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { stagingBatches, stagingPlans, stagingTrials, testParts, testRuns } from '../../db/schema.js';
import { evaluateStagingPin } from './staging-pin.js';
import type { StagingPrivateContext } from './staging-plans.js';

export interface StagingTrialCompletion { trialId: string; runId: string; expectedVersion: number }
export type StagingTrialSettlement = { status: 'passed' | 'unattributed'; trialId: string; version: number; partIds: string[] }
  | { status: 'waiting' | 'unavailable' | 'stale' | 'disabled' };

const Completion = z.strictObject({ trialId: z.uuid(), runId: z.uuid(), expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1) });

/* Records native completion only. Neither an exit code nor the persisted tail establishes a failing-test identity. */
export async function settleRegisteredStagingTrial(ctx: StagingPrivateContext, input: StagingTrialCompletion): Promise<StagingTrialSettlement> {
  const parsed = Completion.safeParse(input);
  if (!parsed.success || !z.uuid().safeParse(ctx.companyId).success) return { status: 'stale' };
  const q = parsed.data, companyId = ctx.companyId;
  return ctx.db.transaction(async (tx): Promise<StagingTrialSettlement> => {
    const [hint] = await tx.select({ batchId: stagingBatches.id, planId: stagingBatches.planId }).from(stagingTrials)
      .innerJoin(stagingBatches, and(eq(stagingBatches.companyId, stagingTrials.companyId), eq(stagingBatches.id, stagingTrials.batchId)))
      .where(and(eq(stagingTrials.companyId, companyId), eq(stagingTrials.id, q.trialId)));
    if (!hint) return { status: 'stale' };
    const [plan] = await tx.select().from(stagingPlans).where(and(eq(stagingPlans.id, hint.planId), eq(stagingPlans.companyId, companyId))).for('update');
    const [batch] = await tx.select().from(stagingBatches).where(and(eq(stagingBatches.id, hint.batchId), eq(stagingBatches.companyId, companyId))).for('update');
    const [trial] = await tx.select().from(stagingTrials).where(and(eq(stagingTrials.id, q.trialId), eq(stagingTrials.companyId, companyId))).for('update');
    if (!plan || !batch || !trial || !plan.isCurrent || batch.planId !== plan.id || batch.planGeneration !== plan.generation || batch.baseSha !== plan.baseSha
      || trial.batchId !== batch.id || !['checking', 'splitting'].includes(batch.phase) || trial.testRunId !== q.runId || !trial.candidateSha) return { status: 'stale' };
    if (!plan.enabled) return { status: 'disabled' };
    const replay = ['passed', 'unattributed'].includes(trial.phase) && trial.version === q.expectedVersion + 1;
    if (!replay && (trial.phase !== 'checking' || trial.version !== q.expectedVersion)) return { status: 'stale' };
    const [run] = await tx.select().from(testRuns).where(and(eq(testRuns.id, q.runId), eq(testRuns.companyId, companyId)));
    if (!run) return { status: 'unavailable' };
    const parts = await tx.select().from(testParts).where(eq(testParts.runId, run.id));
    const proof = evaluateStagingPin({ companyId, runId: run.id, taskId: run.taskId, jobId: run.jobId,
      agentId: run.agentId, commitSha: trial.candidateSha, parts: run.parts }, run, parts);
    if (!('partIds' in proof)) return { status: proof.status };
    if (!run.finishedAt || parts.some(part => !part.finishedAt)) return { status: 'unavailable' };
    const status = proof.status === 'passed' ? 'passed' : 'unattributed';
    if (replay) {
      return trial.phase === status && JSON.stringify(trial.partIds) === JSON.stringify(proof.partIds)
        ? { status, trialId: trial.id, version: trial.version, partIds: [...trial.partIds] } : { status: 'stale' };
    }
    const [saved] = await tx.update(stagingTrials).set({ phase: status, partIds: proof.partIds, failure: null, version: trial.version + 1, updatedAt: new Date() })
      .where(and(eq(stagingTrials.id, trial.id), eq(stagingTrials.companyId, companyId), eq(stagingTrials.version, q.expectedVersion))).returning({ version: stagingTrials.version });
    return saved ? { status, trialId: trial.id, version: saved.version, partIds: proof.partIds } : { status: 'stale' };
  });
}
