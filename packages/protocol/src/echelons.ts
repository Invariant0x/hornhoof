import { z } from 'zod';

/* One ordered route and one current owner for executable work. */
export const ECHELON_STAGES = ['architecture', 'development', 'review', 'cleanup', 'security', 'tests'] as const;
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
  resultKind: 'code' | 'coordination';
  revision: number;
  stage: EchelonStage | null;
  phase: EchelonPhase;
  ownerAgentId: string | null;
  stages: EchelonStep[];
  candidateId: string | null;
  assignment: EchelonModel | null;
  security: { required: boolean; reason: string | null; addedBy: string | null };
};

export const EchelonModel = z.object({ agentId: z.uuid(), provider: z.string().min(1), model: z.string().min(1), capability: z.number().int().min(0).max(2) }).strict();
export type EchelonModel = z.infer<typeof EchelonModel>;
export const EchelonCandidate = z.object({
  id: z.uuid(), parentId: z.uuid().nullable(), revision: z.number().int().positive(),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/), commit: z.string().regex(/^[a-f0-9]{40}$/), branch: z.string().min(1),
  paths: z.array(z.string()), producedBy: EchelonModel.extend({ stage: z.enum(ECHELON_STAGES) }),
}).strict();
export type EchelonCandidate = z.infer<typeof EchelonCandidate>;
