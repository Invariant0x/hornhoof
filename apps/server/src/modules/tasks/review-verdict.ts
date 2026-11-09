import type { NewIssue } from './review-findings.js';

export type ReviewVerdict = { pass: boolean; reviewedCommit?: string; security?: string; escalate?: boolean; returnToAuthor?: boolean; issues?: NewIssue[]; evidence?: object[] };

/* Live branch freshness remains a separate fact; it cannot certify a different pinned candidate. */
export function bindReviewEvidence<T extends object>(runs: T[], commit: string | null): T[] {
  return runs.map(run => {
    if (!('proves' in run)) return run;
    if (commit !== null && 'commitSha' in run && run.commitSha === commit) return run;
    return { ...run, proves: false, why: `This run does not match the pinned review commit ${commit ?? '(unavailable)'}.` };
  });
}

