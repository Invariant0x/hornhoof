export interface StagingBatchScope { companyId: string; repositoryId: string; turnId: string }
export interface EligibleStagingSubmission extends StagingBatchScope { submissionId: string; taskId: string; acceptedAtMs: number }
export interface StagingBatchPolicy { enabled: boolean; maxBatchSize: number; maxWaitMs: number }
/* Unmeasured bootstrap: no added wait; remains disabled until the head enables the actual controller. */
export const INITIAL_STAGING_BATCH_POLICY: StagingBatchPolicy = { enabled: false, maxBatchSize: 4, maxWaitMs: 0 };
export interface StagingBatchInput { scope: StagingBatchScope; eligible: EligibleStagingSubmission[]; nowMs: number; policy?: StagingBatchPolicy }
export type StagingBatchDecision = { status: 'disabled' | 'empty' | 'unavailable' } | { status: 'waiting'; retryAtMs: number }
  | { status: 'ready'; reason: 'size' | 'window'; submissionIds: string[] };

/* Scheduling only. Private admission/author-quality checks and atomic durable claiming belong to the caller. */
export function chooseStagingBatch(input: StagingBatchInput): StagingBatchDecision {
  void input;
  return { status: 'unavailable' };
}
