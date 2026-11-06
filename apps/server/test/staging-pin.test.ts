import { describe, expect, it } from 'vitest';
import { evaluateStagingPin, type StagingNativePart, type StagingNativeRun, type StagingPinnedRun } from '../src/modules/tasks/staging-pin.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const M = 'b'.repeat(40);
function fixture(): { expected: StagingPinnedRun; run: StagingNativeRun; parts: StagingNativePart[] } {
  return { expected: { companyId: id(1), runId: id(2), taskId: id(3), jobId: id(4), agentId: id(5), commitSha: M, parts: 2 },
    run: { id: id(2), companyId: id(1), taskId: id(3), jobId: id(4), agentId: id(5), kind: 'tests', commitSha: M, parts: 2, status: 'passed' },
    parts: [1, 2].map(part => ({ id: id(10 + part), companyId: id(1), runId: id(2), part, commit: M, status: 'passed', exitCode: 0, error: null })) };
}
const check = (f: ReturnType<typeof fixture>) => evaluateStagingPin(f.expected, f.run, f.parts);

describe('staging native pin and completion evidence', () => {
  it('requires both completed parts on the immutable candidate', () => {
    expect(check(fixture())).toEqual({ status: 'passed', partIds: [id(11), id(12)] });
  });
  it('returns part IDs in ordinal order without mutating native records', () => {
    const f = fixture(); f.parts.reverse(); const before = structuredClone(f);
    expect(check(f)).toEqual({ status: 'passed', partIds: [id(11), id(12)] });
    expect(f).toEqual(before);
  });
  it('keeps a complete failed command unattributed until failing-test evidence exists', () => {
    const f = fixture(); f.run.status = 'failed'; f.parts[1] = { ...f.parts[1]!, status: 'failed', exitCode: 1, error: 'failed' };
    expect(check(f)).toEqual({ status: 'failed_unattributed', partIds: [id(11), id(12)] });
  });
  it('supports legacy native SHA256 pins without weakening workspace receipt SHA40', () => {
    const f = fixture(), pin = 'c'.repeat(64); f.expected.commitSha = pin; f.run.commitSha = pin;
    f.parts = f.parts.map(part => ({ ...part, commit: pin }));
    expect(check(f)).toEqual({ status: 'passed', partIds: [id(11), id(12)] });
  });
  it('does not promote terminal parts while the run still waits for settlement', () => {
    const f = fixture(); f.run.status = 'running';
    expect(check(f)).toEqual({ status: 'waiting' });
  });
  it('keeps a running partial inventory waiting', () => {
    const f = fixture(); f.run.status = 'running'; f.parts = [{ ...f.parts[0]!, status: 'running', commit: null, exitCode: null }];
    expect(check(f)).toEqual({ status: 'waiting' });
  });
  it.each([
    { id: id(90) }, { companyId: id(90) }, { taskId: id(90) }, { jobId: id(90) }, { agentId: id(90) },
    { kind: 'work' as const }, { commitSha: 'd'.repeat(40) }, { commitSha: null }, { parts: 1 },
  ])('rejects unrelated run metadata %j', change => {
    const f = fixture(); f.run = { ...f.run, ...change };
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it.each([
    { companyId: id(90) }, { runId: id(90) }, { commit: 'd'.repeat(40) }, { commit: null }, { part: 3 },
  ])('rejects a mismatched part %j even after native PASS', change => {
    const f = fixture(); f.parts[0] = { ...f.parts[0]!, ...change };
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it.each([0, 1])('rejects a terminal inventory truncated to %s parts', count => {
    const f = fixture(); f.parts.length = count;
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it('rejects duplicate part IDs even when both ordinals exist', () => {
    const f = fixture(); f.parts[1]!.id = f.parts[0]!.id;
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it('rejects duplicate ordinals even when IDs differ', () => {
    const f = fixture(); f.parts[1]!.part = 1;
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it.each(['queued', 'running', 'stopped'] as const)('refuses an unsettled %s part in a terminal run', status => {
    const f = fixture(); f.parts[0]!.status = status;
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it.each(['cancelled', 'timeout', 'clone_failed', 'commit_mismatch'])('never attributes infrastructure error %s to an author', error => {
    const f = fixture(); f.run.status = 'failed'; f.parts[0] = { ...f.parts[0]!, status: 'failed', exitCode: 1, error };
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it('refuses a stopped run even when old PASS parts remain', () => {
    const f = fixture(); f.run.status = 'stopped';
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it.each([
    { status: 'passed' as const, exitCode: 1, error: null },
    { status: 'passed' as const, exitCode: 0, error: 'failed' },
    { status: 'failed' as const, exitCode: 0, error: 'failed' },
    { status: 'failed' as const, exitCode: null, error: 'failed' },
  ])('rejects inconsistent part completion %j', change => {
    const f = fixture(); f.run.status = 'failed'; f.parts[0] = { ...f.parts[0]!, ...change };
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it('refuses a failed part hidden by a passed run status', () => {
    const f = fixture(); f.parts[0] = { ...f.parts[0]!, status: 'failed', exitCode: 1, error: 'failed' };
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it('refuses a failed run with only passed parts', () => {
    const f = fixture(); f.run.status = 'failed';
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it.each([0, -1, 1.5, 11])('refuses invalid expected part count %s', count => {
    const f = fixture(); f.expected.parts = count;
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
  it('refuses a malformed expected pin even when every native row repeats it', () => {
    const f = fixture(), bad = 'f'.repeat(39); f.expected.commitSha = bad; f.run.commitSha = bad;
    f.parts = f.parts.map(part => ({ ...part, commit: bad }));
    expect(check(f)).toEqual({ status: 'unavailable' });
  });
});
