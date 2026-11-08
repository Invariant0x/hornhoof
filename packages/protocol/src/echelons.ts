/* One ordered route and one current owner for executable work. */
export const ECHELON_STAGES = ['architecture', 'development', 'review', 'security', 'tests'] as const;
export type EchelonStage = (typeof ECHELON_STAGES)[number];
export type EchelonPhase = 'active' | 'waiting' | 'escalated' | 'ready' | 'done';
export type EchelonStep = {
  stage: EchelonStage;
  status: 'pending' | 'active' | 'complete' | 'skipped';
  ownerAgentId: string | null;
  reason: string | null;
  inputCandidateId: string | null;
  candidateId: string | null;
};
export type EchelonsSnapshot = {
  kind: 'development_echelons';
  version: 1;
  revision: number;
  stage: EchelonStage;
  phase: EchelonPhase;
  ownerAgentId: string | null;
  stages: EchelonStep[];
  candidateId: string | null;
  security: { required: boolean; reason: string | null; addedBy: string | null };
};
