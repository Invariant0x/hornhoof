import type { EchelonStage, EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import type { EmployeeTask } from '../../src/types';

const ROUTE: EchelonStage[] = ['architecture', 'development', 'review', 'security', 'tests'];
const STAGES: EchelonStage[] = ['development', 'review', 'security', 'tests'];

/* A task's route at one stage: 0 writes it, 1 reviews it, 2 checks its security, 3 tests it. Architecture is skipped, as
   most tasks skip it, and security too until the task reaches it. A task with no gates is turnkey: its holder does it
   alone, with no stages. */
export function routeAt(stage = 0, gateCount = 3): EchelonsSnapshot {
  const at = STAGES[Math.min(stage, STAGES.length - 1)]!;
  const base: EchelonsSnapshot = {
    kind: 'development_echelons', version: 1, resultKind: 'code', revision: 1, stage: at, phase: 'active', ownerAgentId: null,
    candidateId: null, assignment: null, abilities: {}, security: { required: at === 'security', reason: null, addedBy: null },
    stages: ROUTE.map((name, i) => ({
      stage: name, ownerAgentId: null, inputCandidateId: null, candidateId: null, reason: null,
      status: name === 'architecture' || (name === 'security' && at !== 'security' && i > ROUTE.indexOf(at)) ? 'skipped' : i < ROUTE.indexOf(at) ? 'complete' : i === ROUTE.indexOf(at) ? 'active' : 'pending',
    })),
  };
  return gateCount === 0 ? { ...base, resultKind: 'turnkey', stage: null, stages: [] } : base;
}

/* The task an employee is about, as the map and the tree show it. */
export function employeeTask(id: string, number: number, title: string, stage = 0, gateCount = 3): EmployeeTask {
  return { echelons: routeAt(stage, gateCount), id, number, title };
}
