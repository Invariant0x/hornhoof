export interface StagingFailureTest { suiteId: string; file: string; test: string }
interface StagingSubsetIdentity {
  batchId: string; baseSha: string; members: string[]; commitSha: string; runId: string; partIds: string[];
}
export type StagingSubsetCheck = StagingSubsetIdentity & ({ status: 'passed' } | { status: 'failed'; failure: StagingFailureTest });
export interface StagingSplitInput { batchId: string; baseSha: string; members: string[]; checks: StagingSubsetCheck[] }
export type StagingSplitDecision = { status: 'unavailable' } | { status: 'check'; members: string[] }
  | { status: 'resolved'; accepted: StagingSubsetCheck | null; rejected: { member: string; failure: StagingFailureTest }[];
    interactions: { members: string[]; failure: StagingFailureTest }[] };

/* Pure subset decisions only. A private adapter must establish native result origin. */
export function nextStagingSplit(input: StagingSplitInput): StagingSplitDecision {
  void input;
  return { status: 'unavailable' };
}
