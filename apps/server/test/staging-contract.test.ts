import { describe, expect, it } from 'vitest';
import { matchStagingInclusion, type MergeInclusionReceipt, type StagingInclusionKey } from '../src/modules/tasks/staging-contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const H = 'a'.repeat(40), M = 'b'.repeat(40);
function receipt(): MergeInclusionReceipt {
  return { receiptId: id(1), repositoryId: id(2), taskId: id(3), workspaceId: id(4), bindingVersion: 1,
    submissionRevision: 1, taskBranch: `task-${id(3)}`, submittedHeadSha: H, publicationReceiptId: id(5),
    integrationKind: 'turn', integrationRef: 'turn-8', integrationCommitSha: M, batchOrReleaseId: id(6),
    confirmedAt: '2026-11-06T06:00:00.000Z' };
}
function key(): StagingInclusionKey {
  return { companyId: id(7), repositoryId: id(2), taskId: id(3), workspaceId: id(4), bindingVersion: 1,
    submissionRevision: 1, taskBranch: `task-${id(3)}`, submittedHeadSha: H, publicationReceiptId: id(5),
    integrationKind: 'turn', integrationRef: 'turn-8' };
}
const record = () => ({ companyId: id(7), receipt: receipt() });

describe('private staging inclusion contract matching', () => {
  it('matches the exact source H to a different squash commit M without ancestry guesses', () => {
    expect(matchStagingInclusion(record(), key())).toEqual(receipt());
  });
  it('matches a separately produced main receipt only to its exact main target', () => {
    const source = record(), expected = key();
    source.receipt.integrationKind = 'main'; source.receipt.integrationRef = 'main';
    expected.integrationKind = 'main'; expected.integrationRef = 'main';
    expect(matchStagingInclusion(source, expected)).toEqual({ ...receipt(), integrationKind: 'main', integrationRef: 'main' });
  });
  it('returns independent data instead of exposing a private stored object to mutation', () => {
    const source = record(), result = matchStagingInclusion(source, key());
    expect(result).not.toBeNull();
    if (result) result.integrationCommitSha = 'c'.repeat(40);
    expect(source.receipt.integrationCommitSha).toBe(M);
  });
  it.each([
    ['companyId', id(20)], ['repositoryId', id(21)], ['taskId', id(22)], ['workspaceId', id(23)],
    ['bindingVersion', 2], ['submissionRevision', 2], ['taskBranch', 'task-another'],
    ['submittedHeadSha', 'c'.repeat(40)], ['publicationReceiptId', id(24)],
    ['integrationKind', 'main'], ['integrationRef', 'turn-9'],
  ])('refuses a different current %s', (field, value) => {
    expect(matchStagingInclusion(record(), { ...key(), [field as string]: value })).toBeNull();
  });
  it.each([
    ['receiptId', 'not-a-uuid'], ['repositoryId', 'not-a-uuid'], ['taskId', null], ['workspaceId', id(4).slice(1)],
    ['bindingVersion', 0], ['bindingVersion', 1.5], ['submissionRevision', -1], ['submissionRevision', 1.5],
    ['submittedHeadSha', 'a'.repeat(64)], ['submittedHeadSha', 'A'.repeat(40)], ['integrationCommitSha', 'b'.repeat(39)],
    ['publicationReceiptId', null], ['integrationKind', 'other'], ['batchOrReleaseId', 'not-a-uuid'],
    ['confirmedAt', 'yesterday'], ['confirmedAt', null],
  ])('rejects malformed receipt field %s=%s', (field, value) => {
    const source = record();
    expect(matchStagingInclusion({ ...source, receipt: { ...source.receipt, [field as string]: value } }, key())).toBeNull();
  });
  it.each(['HEAD~1', '--other', 'a..b', 'a//b', 'a.lock', 'a/./b', 'a\nb', ''])('rejects nonliteral receipt ref %j', ref => {
    const source = record();
    expect(matchStagingInclusion({ ...source, receipt: { ...source.receipt, integrationRef: ref } }, { ...key(), integrationRef: ref })).toBeNull();
    expect(matchStagingInclusion({ ...source, receipt: { ...source.receipt, taskBranch: ref } }, { ...key(), taskBranch: ref })).toBeNull();
  });
  it.each([null, {}, { merged: true }, { status: 'done' }, { trusted: true }])('does not replace a complete record with %j', value => {
    expect(matchStagingInclusion(value, key())).toBeNull();
  });
  it('rejects extra producer claims rather than accepting them as authority', () => {
    expect(matchStagingInclusion({ ...record(), trusted: true }, key())).toBeNull();
    expect(matchStagingInclusion({ ...record(), receipt: { ...receipt(), merged: true } }, key())).toBeNull();
    expect(matchStagingInclusion(record(), { ...key(), trusted: true })).toBeNull();
  });
  it('refuses malformed expected identity even when the same malformed value appears in the record', () => {
    expect(matchStagingInclusion({ ...record(), companyId: 'invalid' }, { ...key(), companyId: 'invalid' })).toBeNull();
    expect(matchStagingInclusion({ ...record(), receipt: { ...receipt(), bindingVersion: 0 } }, { ...key(), bindingVersion: 0 })).toBeNull();
  });
});
