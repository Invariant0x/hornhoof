const source = {
  findingId: 'finding-a', sourceEventId: 'source-event-a', stage: 'review' as const,
  candidateId: 'input-candidate', reviewedCommit: 'a'.repeat(40),
  authorId: 'b1', reviewerId: 'reviewer', reviewerVendor: 'claude', reviewerModel: 'review-model',
  fixCandidateId: 'fix-candidate', fixCommit: 'b'.repeat(40), confirmationEventIds: ['confirmation-event-a'],
};

export const ECHELON_FINDINGS = {
  status: 'available' as const,
  counts: { review: { reported: 2, confirmed: 1 }, security: { reported: 0, confirmed: 0 } },
  sources: [source, { ...source, findingId: 'finding-b', sourceEventId: 'source-event-b', fixCandidateId: null, fixCommit: null, confirmationEventIds: [] }],
};
