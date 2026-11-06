import type { StagingPrivateContext } from './staging-plans.js';

export interface StagingTrialCompletion { trialId: string; runId: string; expectedVersion: number }
export type StagingTrialSettlement = { status: 'passed' | 'unattributed'; trialId: string; version: number; partIds: string[] }
  | { status: 'waiting' | 'unavailable' | 'stale' | 'disabled' };

export async function settleRegisteredStagingTrial(_ctx: StagingPrivateContext, _input: StagingTrialCompletion): Promise<StagingTrialSettlement> {
  return { status: 'unavailable' };
}
