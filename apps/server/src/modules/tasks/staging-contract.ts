export interface MergeInclusionReceipt {
  receiptId: string;
  repositoryId: string;
  taskId: string;
  workspaceId: string;
  bindingVersion: number;
  submissionRevision: number;
  taskBranch: string;
  submittedHeadSha: string;
  publicationReceiptId: string;
  integrationKind: 'turn' | 'main';
  integrationRef: string;
  integrationCommitSha: string;
  batchOrReleaseId: string;
  confirmedAt: string;
}
export interface StagingInclusionKey {
  companyId: string;
  repositoryId: string;
  taskId: string;
  workspaceId: string;
  bindingVersion: number;
  submissionRevision: number;
  taskBranch: string;
  submittedHeadSha: string;
  publicationReceiptId: string;
  integrationKind: 'turn' | 'main';
  integrationRef: string;
}

/* Contract scaffold only. A matching DTO is never evidence of a trusted producer. */
export function matchStagingInclusion(record: unknown, expected: unknown): MergeInclusionReceipt | null {
  void record; void expected;
  return null;
}
