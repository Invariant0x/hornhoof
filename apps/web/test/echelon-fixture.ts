import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { DEV_ORG, TASK_DETAIL } from './api-mock';

export const ECHELON_WORKFLOW: EchelonsSnapshot = {
  kind: 'development_echelons', version: 1, resultKind: 'code', revision: 3, stage: 'review', phase: 'active', ownerAgentId: 'reviewer',
  candidateId: 'candidate-1', assignment: null, abilities: {}, security: { required: false, reason: null, addedBy: null },
  stages: [
    { stage: 'architecture', ownerAgentId: null, inputCandidateId: null, candidateId: null, status: 'skipped', reason: 'Small task' },
    { stage: 'development', ownerAgentId: 'b1', inputCandidateId: null, candidateId: 'candidate-1', status: 'complete', reason: null },
    { stage: 'review', ownerAgentId: 'reviewer', inputCandidateId: 'candidate-1', candidateId: null, status: 'active', reason: null },
    { stage: 'security', ownerAgentId: null, inputCandidateId: null, candidateId: null, status: 'skipped', reason: 'Not required' },
    { stage: 'tests', ownerAgentId: 'tester', inputCandidateId: null, candidateId: null, status: 'pending', reason: null },
  ],
};
const department = DEV_ORG.departments[0]!;
const member = department.employees[1]!;
export const ECHELON_ORG = { ...DEV_ORG, departments: [{ ...department, employees: [
  ...department.employees,
  { ...member, id: 'reviewer', name: 'Rita', roleId: 'DEV-REV' },
  { ...member, id: 'tester', name: 'Tom', roleId: 'DEV-TEST' },
  { ...member, id: 'security', name: 'Sam', roleId: 'DEV-SEC' },
] }] };
/* The engine owner remains authoritative while independently loaded list details refresh. */
export const ECHELON_TASK = { ...TASK_DETAIL, echelons: ECHELON_WORKFLOW, assignee: TASK_DETAIL.executor };
