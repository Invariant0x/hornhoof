export const ECHELON_WORKFLOW = {
  kind: 'development_echelons' as const,
  version: 1 as const,
  revision: 3,
  stage: 'Review' as const,
  state: 'active' as const,
  ownerId: 'reviewer',
  stages: [
    { name: 'Architecture' as const, ownerId: null, status: 'skipped' as const, reason: 'Small task' },
    { name: 'Development' as const, ownerId: 'b1', status: 'complete' as const, reason: null },
    { name: 'Review' as const, ownerId: 'reviewer', status: 'active' as const, reason: null },
    { name: 'Security' as const, ownerId: null, status: 'skipped' as const, reason: 'Not required' },
    { name: 'Tests' as const, ownerId: 'tester', status: 'pending' as const, reason: null },
  ],
  candidate: null,
  security: { required: false, reason: null, addedBy: null },
  findings: { Review: { reported: 2, confirmed: 1 }, Security: { reported: 0, confirmed: 0 } },
};

