import type { TestUnit } from '@hornhoof/protocol';

export type FileDuration = { suiteId: string; file: string; ms: number };
export type TestPartPlanInput = {
  units: TestUnit[];
  durations: FileDuration[];
  /* Supplied by the existing compatible physical-host admission, never a public machine choice. */
  availableMachines: number;
  costs: { setupMs: number; collectMs: number };
  unknownFileMs: number;
};
export type PlannedTestPart = { units: TestUnit[]; testMs: number };
export type PartEstimate = { parts: number; estimatedWallMs: number; costAdjustedMs: number };
export type TestPartPlan = {
  parts: PlannedTestPart[];
  oneMachineMs: number;
  estimatedWallMs: number;
  costAdjustedMs: number;
  alternatives: PartEstimate[];
  unknownUnits: TestUnit[];
  waitingForCapacity: boolean;
  reason: string;
};

/* The first published checkpoint deliberately leaves the new behavior absent for its remote RED proof. */
export function planTestParts(input: TestPartPlanInput): TestPartPlan {
  void input;
  throw new Error('Historical test part planning is not implemented.');
}
