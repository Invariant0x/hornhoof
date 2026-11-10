import type { EchelonStage, EchelonStep, HandedCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import type { Route } from './echelons-store.js';
import { checkerFor, departmentHead } from './echelons-assign.js';
import type { CheckerIdentity } from './echelons-policy.js';
import { refuse, type Task, type Wake } from './engine.js';

function advancedSteps(route: Route, next: EchelonStep, owner: CheckerIdentity | null, candidateId: string): EchelonStep[] {
  return route.state.stages.map((step): EchelonStep => {
    if (step.stage === route.state.stage) return { ...step, status: 'complete', candidateId };
    if (step.stage === next.stage) return { ...step, status: owner ? 'active' : 'pending', ownerAgentId: owner?.agentId ?? null, reason: owner ? null : 'eligible_owner_required', inputCandidateId: candidateId };
    return step;
  });
}

async function handoffWake(ctx: Pick<Ctx, 'db'>, task: Task, stage: EchelonStage, owner: CheckerIdentity | null): Promise<Wake> {
  /* The owner of a checking stage ran nothing yet: 'tests' tells of a run of its own that ended. Tests is open work of its owner,
     never handed to another once it has a candidate. */
  if (owner) return { agentId: owner.agentId, taskId: task.id, why: stage === 'tests' ? 'assigned' : 'review' };
  return { agentId: await departmentHead(ctx.db, task), taskId: task.id, why: 'blocked', text: `${stage} needs an eligible owner with the required ability and a model not weaker than the producer.` };
}

function handoffTask(stage: EchelonStage, owner: CheckerIdentity | null): Partial<Task> {
  return { status: owner ? (stage === 'tests' ? 'open' : 'review') : 'waiting', assigneeAgentId: owner?.agentId ?? null, silent: 0 };
}

/* Past its last stage the result is ready, and the head of the department accepts it. */
async function readyHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate): Promise<Handoff> {
  const headId = await departmentHead(ctx.db, task);
  const state: Route['state'] = { ...route.state, phase: 'ready', candidateId: candidate.id, assignment: null,
    stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, status: 'complete', candidateId: candidate.id } : step),
  };
  return { state, set: { status: 'open', assigneeAgentId: headId, silent: 0 }, wakes: [{ agentId: headId, taskId: task.id, why: 'reviewed' }] };
}

type Handoff = { state: Route['state']; set: Partial<Task>; wakes: Wake[] };

export async function forwardHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate): Promise<Handoff> {
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  const next = route.state.stages.slice(at + 1).find(step => step.status !== 'skipped');
  if (!next && route.state.stage === 'tests') throw refuse(409, 'task_invalid', 'Tests must verify the final candidate before integration.');
  if (!next) return readyHandoff(ctx, task, route, candidate);
  const ability = route.state.abilities[next.stage];
  if (!ability) throw refuse(409, 'task_invalid', 'This stage needs its authorized work assignment.');
  const owner = await checkerFor(ctx, task, candidate.producedBy, ability, next.ownerAgentId);
  const state: Route['state'] = { ...route.state, stage: next.stage, phase: owner ? 'active' : 'waiting', candidateId: candidate.id, assignment: owner,
    stages: advancedSteps(route, next, owner, candidate.id),
  };
  return { state, set: handoffTask(next.stage, owner), wakes: [await handoffWake(ctx, task, next.stage, owner)] };
}
