import type { testParts, testRuns } from '../../db/schema.js';

export interface StagingPinnedRun {
  companyId: string;
  runId: string;
  taskId: string;
  jobId: string;
  agentId: string;
  commitSha: string;
  parts: number;
}
export type StagingNativeRun = Pick<typeof testRuns.$inferSelect, 'id' | 'companyId' | 'taskId' | 'jobId' | 'agentId' | 'kind' | 'commitSha' | 'parts' | 'status'>;
export type StagingNativePart = Pick<typeof testParts.$inferSelect, 'id' | 'companyId' | 'runId' | 'part' | 'commit' | 'status' | 'exitCode' | 'error'>;
export type StagingPinResult = { status: 'passed' | 'failed_unattributed'; partIds: string[] }
  | { status: 'waiting' | 'unavailable' };

/* Native pin/completion only; failing-test attribution and private origin are separate. */
export function evaluateStagingPin(expected: StagingPinnedRun, run: StagingNativeRun, parts: StagingNativePart[]): StagingPinResult {
  void expected; void run; void parts;
  return { status: 'unavailable' };
}
