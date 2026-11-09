import type { Route } from './echelons-store.js';

export type ReturnReason = 'tests_found_defect' | 'review_returned';

/* Work that needs its author goes back to the author on Development in the same task: every check after Development runs
   again on the new candidate, and the stage that sent it back says why. The current candidate stays named, so the next
   submission is compared with what was checked. */
export function returnedToAuthor(route: Route, reason: ReturnReason): Route['state'] {
  const from = route.state.stage;
  const development = route.state.stages.findIndex(step => step.stage === 'development');
  return { ...route.state, stage: 'development', phase: 'active', assignment: null, stages: route.state.stages.map((step, at) => {
    if (at === development) return { ...step, status: 'active', reason: null };
    if (at < development || step.status === 'skipped') return step;
    return { ...step, status: 'pending', reason: step.stage === from ? reason : null, inputCandidateId: null, candidateId: null };
  }) };
}
