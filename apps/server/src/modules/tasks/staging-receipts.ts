import { IntegrationTarget, NodeRef, ProductCommitSha, type WorkspaceProblem } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { stagingBatches, stagingOperations, stagingPlans, stagingTrials, taskWorkspaceMergeReceipts, taskWorkspaces, taskWorkspaceSubmissions, testParts, testRuns, turns } from '../../db/schema.js';
import { matchStagingInclusion, type MergeInclusionReceipt } from './staging-contract.js';
import { evaluateStagingPin } from './staging-pin.js';
import type { StagingPrivateContext } from './staging-plans.js';

export interface StagingInclusionQuery {
  repositoryId: string; taskId: string; workspaceId: string; bindingVersion: number; submissionRevision: number;
  taskBranch: string; submittedHeadSha: string; publicationReceiptId: string; target: IntegrationTarget;
}

const Query = z.strictObject({ repositoryId: z.uuid(), taskId: z.uuid(), workspaceId: z.uuid(),
  bindingVersion: z.number().int().positive(), submissionRevision: z.number().int().positive(), taskBranch: z.string().min(1).max(240),
  submittedHeadSha: ProductCommitSha, publicationReceiptId: z.uuid(), target: IntegrationTarget });
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
const missing = (): WorkspaceProblem => ({ code: 'integration_plan_missing', retryable: true });
const stale = (): WorkspaceProblem => ({ code: 'binding_stale', retryable: false });

async function checkedTrial(tx: Tx, companyId: string, trial: typeof stagingTrials.$inferSelect): Promise<boolean> {
  const [run] = trial.testRunId ? await tx.select().from(testRuns).where(and(eq(testRuns.id, trial.testRunId), eq(testRuns.companyId, companyId))) : [];
  if (!run?.finishedAt || !trial.candidateSha) return false;
  const parts = await tx.select().from(testParts).where(eq(testParts.runId, run.id));
  if (parts.some(part => !part.finishedAt)) return false;
  const proof = evaluateStagingPin({ companyId, runId: run.id, taskId: run.taskId, jobId: run.jobId, agentId: run.agentId,
    commitSha: trial.candidateSha, parts: run.parts }, run, parts);
  return proof.status === 'passed' && JSON.stringify(proof.partIds) === JSON.stringify(trial.partIds);
}

async function published(tx: Tx, receipt: typeof taskWorkspaceMergeReceipts.$inferSelect, submissionId: string): Promise<boolean> {
  const companyId = receipt.companyId;
  const [batch] = await tx.select().from(stagingBatches).where(and(eq(stagingBatches.id, receipt.batchOrReleaseId), eq(stagingBatches.companyId, companyId)));
  if (!batch || batch.phase !== 'published' || !batch.completedAt || !batch.submissionIds.includes(submissionId)) return false;
  const [root] = await tx.select({ plan: stagingPlans, turnNumber: turns.number }).from(stagingPlans)
    .innerJoin(turns, and(eq(turns.companyId, stagingPlans.companyId), eq(turns.id, stagingPlans.turnId)))
    .where(and(eq(stagingPlans.id, batch.planId), eq(stagingPlans.companyId, companyId), eq(stagingPlans.generation, batch.planGeneration)));
  if (!root || root.plan.repositoryId !== receipt.repositoryId || root.plan.baseSha !== batch.baseSha
    || root.plan.baseRef !== receipt.integrationRef || receipt.integrationRef !== `turn-${root.turnNumber}`) return false;
  const trials = await tx.select().from(stagingTrials).where(and(eq(stagingTrials.companyId, companyId), eq(stagingTrials.batchId, batch.id),
    eq(stagingTrials.candidateSha, receipt.integrationCommitSha), eq(stagingTrials.phase, 'published')));
  const trial = trials.find(row => row.submissionIds.includes(submissionId));
  if (!trial || !await checkedTrial(tx, companyId, trial)) return false;
  const operations = await tx.select().from(stagingOperations).where(and(eq(stagingOperations.companyId, companyId),
    eq(stagingOperations.batchId, batch.id), eq(stagingOperations.trialId, trial.id)));
  return ['publish_staging', 'publish_turn'].every(kind => {
    const ref = `refs/heads/${receipt.integrationRef}${kind === 'publish_staging' ? '-staging' : ''}`;
    const matching = operations.filter(op => op.kind === kind);
    return matching.length === 1 && matching.every(op => op.phase === 'confirmed' && op.settledAt !== null && NodeRef.safeParse(op.sourceNode).success
      && op.expectedBeforeSha === batch.baseSha && op.expectedAfterSha === receipt.integrationCommitSha && op.expectedRef === ref
      && z.strictObject({ status: z.literal('published'), ref: z.literal(ref), commitSha: z.literal(receipt.integrationCommitSha) }).safeParse(op.result).success);
  });
}

/* Reads only protected publisher records. It neither seals a submission nor confirms a remote effect. */
export async function readRegisteredStagingInclusion(ctx: StagingPrivateContext, query: StagingInclusionQuery): Promise<MergeInclusionReceipt | WorkspaceProblem> {
  const parsed = Query.safeParse(query);
  if (!parsed.success || !z.uuid().safeParse(ctx.companyId).success) return stale();
  const q = parsed.data;
  if (q.target.kind === 'main') return missing();
  return ctx.db.transaction(async (tx): Promise<MergeInclusionReceipt | WorkspaceProblem> => {
    const [workspace] = await tx.select().from(taskWorkspaces).where(and(eq(taskWorkspaces.id, q.workspaceId), eq(taskWorkspaces.companyId, ctx.companyId))).for('share');
    if (!workspace || !workspace.isCurrent || workspace.repositoryId !== q.repositoryId || workspace.taskId !== q.taskId
      || workspace.bindingVersion !== q.bindingVersion || workspace.submissionRevision !== q.submissionRevision || workspace.taskBranch !== q.taskBranch
      || !workspace.requiredIntegrations.some(target => target.kind === q.target.kind && target.ref === q.target.ref)) return stale();
    const [submission] = await tx.select().from(taskWorkspaceSubmissions).where(and(eq(taskWorkspaceSubmissions.companyId, ctx.companyId),
      eq(taskWorkspaceSubmissions.workspaceId, q.workspaceId), eq(taskWorkspaceSubmissions.bindingVersion, q.bindingVersion), eq(taskWorkspaceSubmissions.revision, q.submissionRevision))).for('share');
    if (!submission || submission.headSha !== q.submittedHeadSha || submission.publicationReceiptId !== q.publicationReceiptId) return stale();
    const [stored] = await tx.select().from(taskWorkspaceMergeReceipts).where(and(eq(taskWorkspaceMergeReceipts.companyId, ctx.companyId),
      eq(taskWorkspaceMergeReceipts.workspaceId, q.workspaceId), eq(taskWorkspaceMergeReceipts.bindingVersion, q.bindingVersion),
      eq(taskWorkspaceMergeReceipts.submissionRevision, q.submissionRevision), eq(taskWorkspaceMergeReceipts.integrationKind, q.target.kind),
      eq(taskWorkspaceMergeReceipts.integrationRef, q.target.ref)));
    if (!stored) return missing();
    const { id, companyId, confirmedAt, ...fields } = stored;
    const { target, ...expected } = q;
    const receipt = matchStagingInclusion({ companyId, receipt: { ...fields, receiptId: id, confirmedAt: confirmedAt.toISOString() } },
      { ...expected, companyId: ctx.companyId, integrationKind: target.kind, integrationRef: target.ref });
    return receipt && await published(tx, stored, submission.id) ? receipt : missing();
  }, { isolationLevel: 'repeatable read' });
}
