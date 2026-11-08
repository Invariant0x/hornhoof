import type { EchelonStage, EchelonsSnapshot } from '@hornhoof/protocol/echelons';

/* Shared unit/browser fixture for the one required route. */
export function taskRoute(stage: EchelonStage = 'development', ownerAgentId: string | null = 'b1'): EchelonsSnapshot {
  const names: EchelonStage[] = ['architecture', 'development', 'review', 'security', 'tests'];
  const at = names.indexOf(stage);
  return { kind: 'development_echelons', version: 1, resultKind: 'code', revision: 1, stage, phase: 'active', ownerAgentId, candidateId: null, assignment: null,
    security: { required: false, reason: null, addedBy: null },
    stages: names.map((name, i) => ({ stage: name, ownerAgentId: i === at ? ownerAgentId : null, inputCandidateId: null, candidateId: null,
      status: name === 'architecture' || name === 'security' ? 'skipped' : i < at ? 'complete' : i === at ? 'active' : 'pending', reason: null,
    })),
  };
}
