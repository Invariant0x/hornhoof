import type { TestExecution } from '@hornhoof/protocol';
import type { PreparedEnvironmentPlanInput } from './plan-environment.js';
import type { TestPartPlan } from './plan.js';

export type ProductPlan = { leaves: { selection: TestExecution['selection']; after: number[] }[]; estimate: TestPartPlan | null; reason: string };

export async function planProductParts(input: PreparedEnvironmentPlanInput): Promise<ProductPlan> {
  void input;
  throw new Error('Versioned product execution planning is not implemented.');
}
