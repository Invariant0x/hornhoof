import type { IntegrationTarget, WorkspaceProblem } from '@hornhoof/protocol';
import type { MergeInclusionReceipt } from './staging-contract.js';
import type { StagingPrivateContext } from './staging-plans.js';

export interface StagingInclusionQuery {
  repositoryId: string; taskId: string; workspaceId: string; bindingVersion: number; submissionRevision: number;
  taskBranch: string; submittedHeadSha: string; publicationReceiptId: string; target: IntegrationTarget;
}

export async function readRegisteredStagingInclusion(_ctx: StagingPrivateContext, _query: StagingInclusionQuery): Promise<MergeInclusionReceipt | WorkspaceProblem> {
  return { code: 'integration_plan_missing', retryable: true };
}
