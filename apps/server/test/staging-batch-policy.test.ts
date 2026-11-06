import { describe, expect, it } from 'vitest';
import { chooseStagingBatch, type EligibleStagingSubmission, type StagingBatchInput, type StagingBatchPolicy } from '../src/modules/tasks/staging-batch-policy.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { companyId: id(1), repositoryId: id(2), turnId: id(3) };
const policy: StagingBatchPolicy = { enabled: true, maxBatchSize: 2, maxWaitMs: 30 };
const row = (n: number, acceptedAtMs = 90): EligibleStagingSubmission => ({ ...scope, submissionId: id(n), taskId: id(100 + n), acceptedAtMs });
const input = (eligible: EligibleStagingSubmission[] = [], nowMs = 100): StagingBatchInput => ({ scope, eligible, nowMs, policy });

describe('staging batch scheduling over already eligible private records', () => {
  it('does nothing by default even when eligible work exists', () => {
    const request = input([row(4), row(5)]); delete request.policy;
    expect(chooseStagingBatch(request)).toEqual({ status: 'disabled' });
  });
  it('keeps an explicitly disabled policy from selecting or claiming work', () => {
    expect(chooseStagingBatch({ ...input([row(4), row(5)]), policy: { ...policy, enabled: false } })).toEqual({ status: 'disabled' });
  });
  it('reports an empty eligible lane without scheduling a timer', () => {
    expect(chooseStagingBatch(input())).toEqual({ status: 'empty' });
  });
  it('flushes at the configured size before the window expires', () => {
    expect(chooseStagingBatch(input([row(4), row(5)]))).toEqual({ status: 'ready', reason: 'size', submissionIds: [id(4), id(5)] });
  });
  it('waits until the oldest eligible record reaches its deadline', () => {
    expect(chooseStagingBatch(input([row(4)]))).toEqual({ status: 'waiting', retryAtMs: 120 });
  });
  it('flushes a partial batch at the exact window boundary', () => {
    expect(chooseStagingBatch(input([row(4)], 120))).toEqual({ status: 'ready', reason: 'window', submissionIds: [id(4)] });
  });
  it('keeps waiting one millisecond before the window boundary', () => {
    expect(chooseStagingBatch(input([row(4)], 119))).toEqual({ status: 'waiting', retryAtMs: 120 });
  });
  it('uses oldest acceptance time and caps the ordered batch', () => {
    expect(chooseStagingBatch(input([row(4, 40), row(5, 20), row(6, 10)]))).toEqual({ status: 'ready', reason: 'size', submissionIds: [id(6), id(5)] });
  });
  it('breaks an acceptance timestamp tie by immutable submission ID', () => {
    expect(chooseStagingBatch(input([row(6), row(4), row(5)]))).toEqual({ status: 'ready', reason: 'size', submissionIds: [id(4), id(5)] });
  });
  it('uses the actual configured size rather than a bootstrap constant', () => {
    expect(chooseStagingBatch({ ...input([row(4)]), policy: { ...policy, maxBatchSize: 1 } })).toEqual({ status: 'ready', reason: 'size', submissionIds: [id(4)] });
  });
  it('adds no wait when the configured window is zero', () => {
    expect(chooseStagingBatch({ ...input([row(4)]), policy: { ...policy, maxWaitMs: 0 } })).toEqual({ status: 'ready', reason: 'window', submissionIds: [id(4)] });
  });
  it('bases the next wake on the oldest row instead of the last arrival', () => {
    const request = { ...input([row(4, 80), row(5, 95)]), policy: { ...policy, maxBatchSize: 3 } };
    expect(chooseStagingBatch(request)).toEqual({ status: 'waiting', retryAtMs: 110 });
  });
  it('does not reorder or mutate the private input snapshot', () => {
    const request = input([row(6), row(4), row(5)]), before = structuredClone(request), result = chooseStagingBatch(request);
    expect(result).toEqual({ status: 'ready', reason: 'size', submissionIds: [id(4), id(5)] });
    if (result.status === 'ready') result.submissionIds.length = 0;
    expect(request).toEqual(before);
  });
  it.each([{ companyId: id(99) }, { repositoryId: id(99) }, { turnId: id(99) }])('refuses a mixed private lane %j', change => {
    expect(chooseStagingBatch(input([row(4), { ...row(5), ...change }]))).toEqual({ status: 'unavailable' });
  });
  it('refuses repeated immutable submissions rather than merging twice', () => {
    expect(chooseStagingBatch(input([row(4), row(4)]))).toEqual({ status: 'unavailable' });
  });
  it('refuses two submissions for the same current task', () => {
    expect(chooseStagingBatch(input([row(4), { ...row(5), taskId: row(4).taskId }]))).toEqual({ status: 'unavailable' });
  });
  it.each([{ maxBatchSize: 0 }, { maxBatchSize: -1 }, { maxBatchSize: 1.5 }, { maxWaitMs: -1 }, { maxWaitMs: 1.5 }])('refuses invalid tuning %j', change => {
    expect(chooseStagingBatch({ ...input([row(4)]), policy: { ...policy, ...change } })).toEqual({ status: 'unavailable' });
  });
  it('refuses an acceptance timestamp in the future', () => {
    expect(chooseStagingBatch(input([row(4, 101)]))).toEqual({ status: 'unavailable' });
  });
  it('refuses a malformed scheduling clock', () => {
    expect(chooseStagingBatch(input([row(4)], -1))).toEqual({ status: 'unavailable' });
  });
  it('does not accept caller ready flags as eligibility evidence', () => {
    const request = input([{ ...row(4), ready: true } as EligibleStagingSubmission]);
    expect(chooseStagingBatch(request)).toEqual({ status: 'unavailable' });
  });
});
