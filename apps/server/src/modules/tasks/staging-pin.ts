import { CommitSha, MAX_TEST_PARTS } from '@hornhoof/protocol';
import { z } from 'zod';
import type { testParts, testRuns } from '../../db/schema.js';

const StagingPinnedRun = z.object({
  companyId: z.string().uuid(), runId: z.string().uuid(), taskId: z.string().uuid(),
  jobId: z.string().uuid(), agentId: z.string().uuid(), commitSha: CommitSha,
  parts: z.number().int().min(1).max(MAX_TEST_PARTS),
}).strict();
export type StagingPinnedRun = z.infer<typeof StagingPinnedRun>;
export type StagingNativeRun = Pick<typeof testRuns.$inferSelect, 'id' | 'companyId' | 'taskId' | 'jobId' | 'agentId' | 'kind' | 'commitSha' | 'parts' | 'status'>;
export type StagingNativePart = Pick<typeof testParts.$inferSelect, 'id' | 'companyId' | 'runId' | 'part' | 'commit' | 'status' | 'exitCode' | 'error'>;
export type StagingPinResult = { status: 'passed' | 'failed_unattributed'; partIds: string[] }
  | { status: 'waiting' | 'unavailable' };

function matchesRun(expected: StagingPinnedRun, run: StagingNativeRun): boolean {
  const { runId, ...identity } = expected;
  return Object.entries({ ...identity, id: runId, kind: 'tests' })
    .every(([key, value]) => run[key as keyof StagingNativeRun] === value);
}

function completedPart(part: StagingNativePart): boolean {
  if (part.status === 'passed') return part.exitCode === 0 && part.error === null;
  return part.status === 'failed' && part.exitCode !== null && part.exitCode !== 0
    && (part.error === null || part.error === 'failed');
}

function completeInventory(expected: StagingPinnedRun, parts: StagingNativePart[]): boolean {
  if (parts.length !== expected.parts || new Set(parts.map(part => part.id)).size !== parts.length) return false;
  return parts.every((part, index) => part.part === index + 1 && part.companyId === expected.companyId
    && part.runId === expected.runId && part.commit === expected.commitSha && completedPart(part));
}

/* Native pin/completion only; failing-test attribution and private origin are separate. */
export function evaluateStagingPin(expected: StagingPinnedRun, run: StagingNativeRun, parts: StagingNativePart[]): StagingPinResult {
  if (!StagingPinnedRun.safeParse(expected).success || !matchesRun(expected, run)) return { status: 'unavailable' };
  if (run.status === 'running') return { status: 'waiting' };
  const ordered = [...parts].sort((a, b) => a.part - b.part);
  if (!completeInventory(expected, ordered)) return { status: 'unavailable' };
  const failed = ordered.some(part => part.status === 'failed');
  if (run.status !== (failed ? 'failed' : 'passed')) return { status: 'unavailable' };
  return { status: failed ? 'failed_unattributed' : 'passed', partIds: ordered.map(part => part.id) };
}
