import type { IntegrationTarget, WorkspaceProblem } from '@hornhoof/protocol';
import type { Db } from '../../db/client.js';

export interface StagingPrivateContext { db: Db; companyId: string }
export interface StagingPlanQuery { repositoryId: string; turnId: string | null; urgentLaneId?: string }
export interface RegisteredStagingPlan {
  version: 1; planId: string; generation: number; companyId: string; repositoryId: string; turnId: string;
  baseRef: string; baseSha: string; requiredIntegrations: [IntegrationTarget, ...IntegrationTarget[]];
  health: { checkedCommitSha: string; runId: string; partIds: [string, ...string[]] };
}

export async function resolveRegisteredStagingPlan(ctx: StagingPrivateContext, query: StagingPlanQuery): Promise<RegisteredStagingPlan | WorkspaceProblem> {
  void ctx; void query;
  return { code: 'integration_plan_missing', retryable: true };
}
