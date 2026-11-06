import type { Command, EnvironmentSnapshot, TestExecution } from '@hornhoof/protocol';
import type { TestPartPlan, TestPartPlanInput } from './plan.js';

/* Internal data consistency, not an authorization token, dispatch capability or public free-SHA input. */
export type PreparedEnvironmentPlanInput = TestPartPlanInput & {
  snapshot: EnvironmentSnapshot;
  expectedCommitSha: string;
  purpose: 'affected' | 'final';
};
export type EnvironmentPartPlan = {
  commitSha: string;
  manifestHash: string;
  profile: string;
  testPlan: TestPartPlan;
  parts: { selections: TestExecution['selection'][] }[];
  postSuiteChecks: { suiteId: string; commands: Command[] }[];
  ports: { suiteBatch: 'required' | 'not-required'; finalPreparation: 'missing' | 'not-required' };
};

/* Kept deliberately unimplemented until the targeted remote RED establishes these boundary cases. */
export async function planEnvironmentParts(input: PreparedEnvironmentPlanInput): Promise<EnvironmentPartPlan> {
  void input;
  throw new Error('Pinned environment planning is not implemented.');
}
