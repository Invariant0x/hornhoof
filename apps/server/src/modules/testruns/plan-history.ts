import type { TestFileTiming, TestUnit } from '@hornhoof/protocol';
import type { FileDuration, TestPartPlanInput } from './plan.js';

/* Scope must come from the private canonical repository binding, not a cache owner or an agent claim. */
export type PlanningHistoryScope = { companyId: string; repositoryId: string; manifestHash: string; profile: string };
export type PlanningHistoryPart = {
  scope: PlanningHistoryScope;
  runId: string;
  partId: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'stopped';
  suiteId: string | null;
  files: TestFileTiming[];
  setupMs: number | null;
  /* Actual result collection observation; cleanupMs alone is not this measurement. */
  collectMs: number | null;
};
export type PlanningHistoryInput = {
  scope: PlanningHistoryScope;
  inventory: TestUnit[];
  suiteWorkingDirectories: Record<string, string>;
  parts: PlanningHistoryPart[];
  fallbackCosts: TestPartPlanInput['costs'];
};
export type PlanningHistory = {
  durations: FileDuration[];
  costs: TestPartPlanInput['costs'];
  costBasis: { setup: 'historical' | 'fallback'; collection: 'historical' | 'fallback' };
  usedPartIds: string[];
  unmatchedFiles: number;
};

/* Unimplemented until the remote contract tests establish the scoped history boundary. */
export function planningHistory(input: PlanningHistoryInput): PlanningHistory {
  void input;
  throw new Error('Scoped planning history is not implemented.');
}
