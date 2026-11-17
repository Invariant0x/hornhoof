import type { NewIssue } from './review-findings.js';

/* reviewedCommit names the commit that was checked; where the result is a document, candidateId names it. */
export type ReviewVerdict = { pass: boolean; reviewedCommit?: string; candidateId?: string; security?: string; escalate?: boolean; issues?: NewIssue[] };
