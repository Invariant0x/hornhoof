import { MAX_TEST_PARTS } from '@hornhoof/protocol';
import { z } from 'zod';
import { RepoPath, ReviewSha } from './review-schema.js';

const Ids = z.array(z.uuid()).min(1).refine(ids => new Set(ids).size === ids.length);
const FailureTest = z.strictObject({ suiteId: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), file: RepoPath, test: z.string().min(1).max(1000) });
export type StagingFailureTest = z.infer<typeof FailureTest>;
const SubsetIdentity = {
  batchId: z.uuid(), baseSha: ReviewSha, members: Ids, commitSha: ReviewSha, runId: z.uuid(), partIds: Ids.max(MAX_TEST_PARTS),
};
const SubsetCheck = z.discriminatedUnion('status', [
  z.strictObject({ ...SubsetIdentity, status: z.literal('passed') }),
  z.strictObject({ ...SubsetIdentity, status: z.literal('failed'), failure: FailureTest }),
]);
export type StagingSubsetCheck = z.infer<typeof SubsetCheck>;
type FailedCheck = Extract<StagingSubsetCheck, { status: 'failed' }>;
const SplitInput = z.strictObject({ batchId: z.uuid(), baseSha: ReviewSha, members: Ids, checks: z.array(SubsetCheck) });
export type StagingSplitInput = z.infer<typeof SplitInput>;
type CheckNeeded = { status: 'check'; members: string[] };
interface ResolvedSplit {
  status: 'resolved'; accepted: Extract<StagingSubsetCheck, { status: 'passed' }> | null;
  rejected: { member: string; failure: StagingFailureTest }[];
  interactions: { members: string[]; failure: StagingFailureTest }[];
}
export type StagingSplitDecision = { status: 'unavailable' } | CheckNeeded | ResolvedSplit;

const key = (members: string[]) => members.join(',');
function orderedSubset(members: string[], universe: string[]): boolean {
  const selected = new Set(members);
  return key(universe.filter(member => selected.has(member))) === key(members);
}

function indexChecks(input: StagingSplitInput): Map<string, StagingSubsetCheck> | null {
  const checks = new Map<string, StagingSubsetCheck>();
  for (const check of input.checks) {
    if (check.batchId !== input.batchId || check.baseSha !== input.baseSha || !orderedSubset(check.members, input.members)) return null;
    const previous = checks.get(key(check.members));
    if (previous && JSON.stringify(previous) !== JSON.stringify(check)) return null;
    checks.set(key(check.members), check);
  }
  return checks;
}

function partitions(members: string[], count: number): string[][] {
  const width = Math.ceil(members.length / count), groups: string[][] = [];
  for (let start = 0; start < members.length; start += width) groups.push(members.slice(start, start + width));
  return [...groups, ...groups.map(group => members.filter(member => !group.includes(member)))];
}

function isolate(failed: FailedCheck, checks: Map<string, StagingSubsetCheck>, count = 2): CheckNeeded | { status: 'isolated'; check: FailedCheck } {
  if (failed.members.length === 1) return { status: 'isolated', check: failed };
  for (const members of partitions(failed.members, count)) {
    const check = checks.get(key(members));
    if (!check) return { status: 'check', members };
    if (check.status === 'failed') return isolate(check, checks);
  }
  if (count >= failed.members.length) return { status: 'isolated', check: failed };
  return isolate(failed, checks, Math.min(failed.members.length, count * 2));
}

function diagnose(input: StagingSplitInput, checks: Map<string, StagingSubsetCheck>): StagingSplitDecision {
  const result: ResolvedSplit = { status: 'resolved', accepted: null, rejected: [], interactions: [] };
  let remaining = input.members;
  while (remaining.length) {
    const check = checks.get(key(remaining));
    if (!check) return { status: 'check', members: remaining };
    if (check.status === 'passed') return { ...result, accepted: check };
    const isolated = isolate(check, checks);
    if (isolated.status === 'check') return isolated;
    const { members, failure } = isolated.check;
    if (members.length === 1) result.rejected.push({ member: members[0]!, failure });
    else result.interactions.push({ members, failure });
    remaining = remaining.filter(member => !members.includes(member));
  }
  return result;
}

/* Pure subset decisions only. A private adapter must establish native result origin. */
export function nextStagingSplit(input: StagingSplitInput): StagingSplitDecision {
  const parsed = SplitInput.safeParse(input);
  if (!parsed.success) return { status: 'unavailable' };
  const checks = indexChecks(parsed.data);
  return checks ? diagnose(parsed.data, checks) : { status: 'unavailable' };
}
