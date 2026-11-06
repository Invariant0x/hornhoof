import { describe, expect, it } from 'vitest';
import { nextStagingSplit, type StagingSplitInput, type StagingSubsetCheck } from '../src/modules/tasks/staging-split.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [A, B, C, D] = [id(1), id(2), id(3), id(4)] as [string, string, string, string];
const baseSha = 'a'.repeat(40), batchId = id(10);
const failure = { suiteId: 'unit', file: 'test/totals.test.ts', test: 'keeps totals' };
function trial(members: string[], failed = false, n = 1): StagingSubsetCheck {
  const common = { batchId, baseSha, members, commitSha: String(n).padStart(40, '0'), runId: id(100 + n), partIds: [id(200 + n)] };
  return failed ? { ...common, status: 'failed', failure } : { ...common, status: 'passed' };
}
const input = (members = [A, B, C, D], checks: StagingSubsetCheck[] = []): StagingSplitInput => ({ batchId, baseSha, members, checks });
/* Controlled outcomes exercise the pure planner, not native runners or failure parsers. */
function diagnose(fails: (members: string[]) => boolean, members = [A, B, C, D]) {
  const current = input(members), requested: string[][] = [];
  for (let step = 0; step < 200; step++) {
    const decision = nextStagingSplit(current);
    if (decision.status !== 'check') return { decision, requested, current };
    requested.push([...decision.members]);
    current.checks.push(trial(decision.members, fails(decision.members), step + 1));
  }
  throw new Error('Subset diagnosis did not terminate.');
}

describe('replayable staging subset diagnosis', () => {
  it('requests the entire batch before diagnosing or publishing anything', () => {
    expect(nextStagingSplit(input())).toEqual({ status: 'check', members: [A, B, C, D] });
  });
  it('preserves the exact green candidate and its native run for later publication', () => {
    const green = trial([A, B, C, D]);
    expect(nextStagingSplit(input(undefined, [green]))).toEqual({ status: 'resolved', accepted: green, rejected: [], interactions: [] });
  });
  it('rejects an independently failing single submission with the actual failing test', () => {
    expect(nextStagingSplit(input([B], [trial([B], true)]))).toEqual({
      status: 'resolved', accepted: null, rejected: [{ member: B, failure }], interactions: [],
    });
  });
  it('finds a single bad change by halves and checks the recomposed remainder', () => {
    const result = diagnose(members => members.includes(B));
    expect(result.requested).toEqual([[A, B, C, D], [A, B], [A], [B], [A, C, D]]);
    expect(result.decision).toEqual({ status: 'resolved', accepted: trial([A, C, D], false, 5), rejected: [{ member: B, failure }], interactions: [] });
  });
  it('finds multiple independent defects before accepting the remaining set', () => {
    const { decision } = diagnose(members => members.includes(B) || members.includes(D));
    expect(decision).toMatchObject({ status: 'resolved', accepted: { status: 'passed', members: [A, C] }, rejected: [{ member: B, failure }, { member: D, failure }], interactions: [] });
  });
  it('escalates a pair that fails together while both changes pass alone', () => {
    const { decision, requested } = diagnose(members => members.includes(A) && members.includes(D));
    expect(decision).toMatchObject({ status: 'resolved', accepted: { members: [B, C], status: 'passed' }, rejected: [], interactions: [{ members: [A, D], failure }] });
    expect(requested).toContainEqual([A]); expect(requested).toContainEqual([D]); expect(requested).toContainEqual([A, D]);
    expect(requested.at(-1)).toEqual([B, C]);
  });
  it('keeps a higher order interaction together instead of accusing one author', () => {
    const { decision } = diagnose(members => [A, B, C].every(member => members.includes(member)));
    expect(decision).toMatchObject({ status: 'resolved', accepted: { members: [D] }, rejected: [], interactions: [{ members: [A, B, C], failure }] });
  });
  it('keeps an interaction separate from another independently failing change', () => {
    const { decision } = diagnose(members => members.includes(D) || (members.includes(A) && members.includes(B)));
    expect(decision).toMatchObject({ status: 'resolved', accepted: { members: [C] }, rejected: [{ member: D, failure }], interactions: [{ members: [A, B], failure }] });
  });
  it('does not accept separately green halves as a green combined remainder', () => {
    const checks = [trial([A, B, C], true), trial([A, B], true), trial([A]), trial([B], true)];
    expect(nextStagingSplit(input([A, B, C], checks))).toEqual({ status: 'check', members: [A, C] });
  });
  it('can hold every submission without inventing an empty green run', () => {
    expect(diagnose(() => true, [A, B]).decision).toEqual({ status: 'resolved', accepted: null, rejected: [{ member: A, failure }, { member: B, failure }], interactions: [] });
  });
  it('requests the same missing subset after a process reload', () => {
    const current = input(undefined, [trial([A, B, C, D], true)]);
    expect(nextStagingSplit(current)).toEqual({ status: 'check', members: [A, B] });
    expect(nextStagingSplit(JSON.parse(JSON.stringify(current)) as StagingSplitInput)).toEqual({ status: 'check', members: [A, B] });
  });
  it('does not duplicate work for identical repeated completion records', () => {
    const green = trial([A, B, C, D]);
    expect(nextStagingSplit(input(undefined, [green, structuredClone(green)]))).toEqual({ status: 'resolved', accepted: green, rejected: [], interactions: [] });
  });
  it('returns independent values and leaves input records unchanged', () => {
    const green = trial([A, B, C, D]), current = input(undefined, [green]), before = structuredClone(current);
    const decision = nextStagingSplit(current);
    expect(decision.status).toBe('resolved');
    if (decision.status === 'resolved' && decision.accepted) decision.accepted.members.length = 0;
    expect(current).toEqual(before);
  });
  it.each([
    { batchId: id(99) }, { baseSha: 'b'.repeat(40) }, { members: [A, id(99)] }, { members: [B, A] },
    { members: [A, A] }, { commitSha: 'c'.repeat(39) }, { runId: 'unregistered' }, { partIds: [] }, { partIds: [id(90), id(90)] },
  ])('refuses unrelated or malformed completion %j', change => {
    const check = { ...trial([A, B]), ...change };
    expect(nextStagingSplit(input([A, B], [check]))).toEqual({ status: 'unavailable' });
  });
  it.each(['failed_unattributed', 'cancelled', 'running'])('does not diagnose from %s without a failing test', status => {
    const check = { ...trial([A]), status } as unknown as StagingSubsetCheck;
    expect(nextStagingSplit(input([A], [check]))).toEqual({ status: 'unavailable' });
  });
  it('refuses a failed command without a named failing test', () => {
    const check = { ...trial([A]), status: 'failed' } as unknown as StagingSubsetCheck;
    expect(nextStagingSplit(input([A], [check]))).toEqual({ status: 'unavailable' });
  });
  it.each([
    { ...failure, file: '../private.txt' }, { ...failure, test: '' }, { ...failure, suiteId: '' },
  ])('refuses malformed failing-test evidence %j', invalid => {
    const check = { ...trial([A], true), failure: invalid } as StagingSubsetCheck;
    expect(nextStagingSplit(input([A], [check]))).toEqual({ status: 'unavailable' });
  });
  it.each([
    { commitSha: 'c'.repeat(40) }, { status: 'failed', failure },
  ])('refuses contradictory repeated subset results %j', change => {
    const green = trial([A, B]), changed = { ...green, ...change } as StagingSubsetCheck;
    expect(nextStagingSplit(input([A, B], [green, changed]))).toEqual({ status: 'unavailable' });
  });
  it.each([[], [A, A]])('refuses an invalid batch membership %j', members => {
    expect(nextStagingSplit(input(members))).toEqual({ status: 'unavailable' });
  });
});
