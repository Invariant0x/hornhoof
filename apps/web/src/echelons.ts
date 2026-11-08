/* The task presentation snapshot. The server owns route transitions and validation. */
export type EchelonStage = 'architecture' | 'development' | 'review' | 'security' | 'tests';

export type TaskEchelons = {
  version: 1;
  revision: number;
  stage: EchelonStage;
  phase: 'active' | 'waiting' | 'escalated' | 'ready' | 'done' | 'cancelled';
  ownerAgentId: string | null;
  stages: {
    stage: EchelonStage;
    roleKey: string;
    ownerAgentId: string | null;
    inputCandidateId: string | null;
    status: 'pending' | 'active' | 'complete' | 'skipped';
    reason: string | null;
  }[];
  candidateId: string | null;
  security: { included: boolean; reason: string | null; addedByAgentId: string | null };
};
