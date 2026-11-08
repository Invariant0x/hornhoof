import type { EchelonCandidate, EchelonStage } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import type { Route } from './echelons-store.js';
import { checkerFor } from './echelons-assign.js';
import { giver, refuse, type Task, type Wake } from './engine.js';

const ABILITIES: Partial<Record<EchelonStage, string>> = {
  review: 'dev-review-diff', cleanup: 'dev-cleanup', security: 'dev-security-review', tests: 'dev-test-environment',
};

export async function forwardHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: EchelonCandidate): Promise<{ state: Route['state']; set: Partial<Task>; wakes: Wake[] }> {
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  const next = route.state.stages.slice(at + 1).find(step => step.status !== 'skipped');
  if (!next) throw refuse(409, 'task_invalid', 'Tests must verify the final candidate before integration.');
  const ability = ABILITIES[next.stage];
  if (!ability) throw refuse(409, 'task_invalid', 'This stage needs its authorized work assignment.');
  const owner = await checkerFor(ctx, task, candidate.producedBy, ability, next.ownerAgentId);
  const state: Route['state'] = { ...route.state, stage: next.stage, phase: owner ? 'active' : 'waiting', candidateId: candidate.id, assignment: owner,
    stages: route.state.stages.map(step => {
      if (step.stage === route.state.stage) return { ...step, status: 'complete', candidateId: candidate.id };
      if (step.stage === next.stage) return { ...step, status: owner ? 'active' : 'pending', ownerAgentId: owner?.agentId ?? null, reason: owner ? null : 'eligible_owner_required', inputCandidateId: candidate.id };
      return step;
    }),
  };
  const wakes: Wake[] = owner ? [{ agentId: owner.agentId, taskId: task.id, why: next.stage === 'tests' ? 'tests' : 'review' }]
    : giver(task, 'blocked', task.assigneeAgentId ?? undefined, `${next.stage} needs an eligible owner with the required ability and a model not weaker than the producer.`);
  return { state, set: { status: owner ? (next.stage === 'tests' ? 'open' : 'review') : 'waiting', assigneeAgentId: owner?.agentId ?? null, silent: 0 }, wakes };
}
