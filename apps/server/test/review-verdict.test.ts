import { describe, expect, it } from 'vitest';
import { bindReviewEvidence } from '../src/modules/tasks/review-verdict.js';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40);

describe('pure binding of run evidence to a candidate', () => {
  it('keeps a matching passed receipt bound to that exact candidate', () => {
    const run = { commitSha: SHA, proves: true, status: 'passed' };
    expect(bindReviewEvidence([run], SHA)).toEqual([run]);
  });

  it('keeps a matching failed receipt failed', () => {
    const run = { commitSha: SHA, proves: false, status: 'failed' };
    expect(bindReviewEvidence([run], SHA)).toEqual([run]);
  });

  it.each([OTHER, null])('refuses to certify a receipt against candidate %s without mutating it', candidate => {
    const run = { commitSha: SHA, proves: true, status: 'passed' };
    expect(bindReviewEvidence([run], candidate)).toEqual([{ ...run, proves: false, why: expect.stringContaining('pinned review commit') }]);
    expect(run.proves).toBe(true);
  });

  it('keeps unrelated records and empty evidence without inventing proof', () => {
    expect(bindReviewEvidence([{ note: 'No run recorded.' }], SHA)).toEqual([{ note: 'No run recorded.' }]);
    expect(bindReviewEvidence([], SHA)).toEqual([]);
  });
});
