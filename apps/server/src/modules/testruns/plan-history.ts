import type { FileDuration, TestPartPlanInput } from './plan.js';

export type PlanningHistory = {
  durations: FileDuration[];
  costs: TestPartPlanInput['costs'];
  /* How long each computer takes for the same work against the middle one, from what its parts took. */
  paces?: Map<string, number>;
  /* What a file no part measured counts for, in the time of these durations. */
  unknownFileMs?: number;
  /* How long a preparation that passed took from its start to its end, at the middle pace. */
  preparationMs?: number;
};
