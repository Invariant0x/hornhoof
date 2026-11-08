export const ECHELON_WORKFLOW = {
  version: 1 as const,
  revision: 3,
  stage: 'review' as const,
  phase: 'active' as const,
  ownerAgentId: 'reviewer',
  stages: [
    { stage: 'architecture' as const, roleKey: 'DEV-ARCH', ownerAgentId: null, inputCandidateId: null, status: 'skipped' as const, reason: 'Small task' },
    { stage: 'development' as const, roleKey: 'DEV-ENG', ownerAgentId: 'b1', inputCandidateId: null, status: 'complete' as const, reason: null },
    { stage: 'review' as const, roleKey: 'DEV-REV', ownerAgentId: 'reviewer', inputCandidateId: null, status: 'active' as const, reason: null },
    { stage: 'security' as const, roleKey: 'DEV-SEC', ownerAgentId: null, inputCandidateId: null, status: 'skipped' as const, reason: 'Not required' },
    { stage: 'tests' as const, roleKey: 'DEV-TEST', ownerAgentId: 'tester', inputCandidateId: null, status: 'pending' as const, reason: null },
  ],
  candidateId: null,
  security: { included: false, reason: null, addedByAgentId: null },
};
