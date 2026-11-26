import type { EchelonStage, EchelonStep, HandedCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import { changeRoute, skippedAuthorReview, type Route } from './route-records.js';
import { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, eq, sql } from 'drizzle-orm';
import { taskEvents } from '../../db/schema.js';
import { reviewSkip, type AuthorReviewSkip } from './author-check.js';
import { checkerFor, departmentHead, excludedCheckingOwners, keptFromReview, NO_DEPARTMENT_CHECKER, uncheckable } from './echelons-assign.js';
import { candidateReceivedAt } from './echelons-candidates.js';
import type { CheckerIdentity } from './echelons-policy.js';
import { refuse, type Moved, type Task, type Tx, type Wake } from './state.js';
import { move } from './transitions.js';

function advancedSteps(route: Route, next: EchelonStep, owner: CheckerIdentity | null, candidateId: string, receivedId: string): EchelonStep[] {
  return route.state.stages.map((step): EchelonStep => {
    if (step.stage === route.state.stage) return { ...step, status: 'complete', candidateId };
    if (step.stage === next.stage) return { ...step, status: owner ? 'active' : 'pending', ownerAgentId: owner?.agentId ?? null, reason: owner ? null : 'eligible_owner_required', inputCandidateId: receivedId };
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
async function readyHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate): Promise<Omit<Handoff, 'skipped'>> {
  const headId = await departmentHead(ctx.db, task);
  const state: Route['state'] = { ...route.state, phase: 'ready', candidateId: candidate.id, assignment: null,
    stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, status: 'complete', candidateId: candidate.id } : step),
  };
  return { state, set: { status: 'open', assigneeAgentId: headId, silent: 0 }, wakes: [{ agentId: headId, taskId: task.id, why: 'reviewed' }] };
}

/* Whether a submission of the task once went past Review on an author check: a Tests return clears that skip from the route,
   and every later candidate of the task still waits for independent Review. */
async function usedAuthorReviewSkip(db: Ctx['db'], task: Task): Promise<boolean> {
  const [skipped] = await db.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.companyId, task.companyId),
    eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data} ? 'authorCheckSkip'`)).limit(1);
  return Boolean(skipped);
}

/* skipped: the checks passed over on the way, as nobody in the department can do them. */
type Handoff = { state: Route['state']; set: Partial<Task>; wakes: Wake[]; skipped: EchelonStage[]; authorCheckSkip?: AuthorReviewSkip };

export async function submittedHandoff(ctx: Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config'>>, task: Task, route: Route, candidate: HandedCandidate): Promise<Handoff> {
  if (skippedAuthorReview(route.state)) return reviewReplacement(ctx, task, route, candidate);
  if (route.state.stage !== 'development') return forwardHandoff(ctx, task, route, candidate);
  const review = route.state.stages.find(step => step.stage === 'review' && step.status === 'pending');
  const risky = task.riskClass !== null && task.riskClass !== 'none';
  const requireReview = await usedAuthorReviewSkip(ctx.db, task);
  if (risky && !route.state.stages.some(step => step.stage === 'security' && step.status === 'pending')) {
    return forwardHandoff(ctx, task, route, candidate, requireReview);
  }
  const parsed = EchelonCandidate.safeParse(candidate);
  const skip = review && parsed.success ? await reviewSkip(ctx, task, parsed.data) : null;
  if (!skip) return forwardHandoff(ctx, task, route, candidate, requireReview);
  const stages = route.state.stages.map(step => step === review
    ? { ...step, status: 'skipped' as const, reason: skip.reason, inputCandidateId: candidate.id }
    : step);
  const next = await forwardHandoff(ctx, task, { ...route, state: { ...route.state, stages } }, candidate);
  return { ...next, authorCheckSkip: skip };
}

/* A replacement has a different submission and cannot inherit the old Review exception. */
export async function reviewReplacement(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate): Promise<Handoff> {
  const review = skippedAuthorReview(route.state);
  const stages = route.state.stages.map((step): EchelonStep => {
    if (step === review || (step.stage !== 'architecture' && step.stage !== 'development' && step.status !== 'skipped')) {
      return { ...step, status: 'pending', reason: null, inputCandidateId: null, candidateId: null };
    }
    return step;
  });
  return forwardHandoff(ctx, task, { ...route, state: { ...route.state, stage: 'development', stages } }, candidate, true);
}

/* A candidate already in flight under the old policy must reach Review before it can be accepted. */
export async function reopenAuthorReview(ctx: Pick<Ctx, 'db' | 'bus'>, task: Task, route: Route, candidate: HandedCandidate, agentId: string, held: (tx: Tx) => Promise<unknown>): Promise<Moved> {
  const next = await reviewReplacement(ctx, task, route, candidate);
  const row = await move(ctx, task, next.set, {
    kind: 'report', actor: { agentId }, text: 'Review is required because this candidate used the old author-check skip.',
    data: { reviewRequired: { candidateId: candidate.id, routeRevision: route.revision } }, returned: true,
  }, async tx => {
    await held(tx);
    await changeRoute(tx, route, next.state);
  }, next.wakes);
  return { task: row, wakes: next.wakes };
}

const plannedOwner = (ownerId: string | null, excluded: ReadonlySet<string>): string | null => ownerId && !excluded.has(ownerId) ? ownerId : null;

/* A stage with no eligible checker may be skipped where the department allows it, never a Review a legacy route must reopen. */
async function skipsUnstaffed(db: Ctx['db'], task: Task, stage: EchelonStage, ability: string, security: Route['state']['security'], requireReview: boolean): Promise<boolean> {
  if (requireReview && stage === 'review') return false;
  return uncheckable(db, task, stage, ability, security);
}

export async function forwardHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate, requireReview = false): Promise<Handoff> {
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  const ahead = route.state.stages.slice(at + 1).filter(step => step.status !== 'skipped');
  if (!ahead.length && route.state.stage === 'tests') throw refuse(409, 'task_invalid', 'Tests must verify the final candidate before integration.');
  const skipped: EchelonStage[] = [];
  let stages = route.state.stages;
  for (const next of ahead) {
    const ability = route.state.abilities[next.stage];
    if (!ability) throw refuse(409, 'task_invalid', 'This stage needs its authorized work assignment.');
    const received = await candidateReceivedAt(ctx.db, task, route, candidate, next.stage);
    /* The stage handing forward completes in this write, so its checker counts as an earlier checker. */
    const excluded = excludedCheckingOwners(task, route.state, next.stage, route.state.stage);
    for (const producer of await keptFromReview(ctx.db, task, next.stage, candidate)) excluded.add(producer);
    const named = plannedOwner(next.ownerAgentId, excluded);
    const owner = await checkerFor(ctx, task, received.producedBy, ability, named, undefined, excluded);
    if (!owner && await skipsUnstaffed(ctx.db, task, next.stage, ability, route.state.security, requireReview)) {
      stages = stages.map(step => step.stage === next.stage ? { ...step, status: 'skipped', reason: NO_DEPARTMENT_CHECKER, ownerAgentId: null } : step);
      skipped.push(next.stage);
      continue;
    }
    const current: Route = { ...route, state: { ...route.state, stages } };
    const state: Route['state'] = { ...route.state, stage: next.stage, phase: owner ? 'active' : 'waiting', candidateId: candidate.id, assignment: owner,
      stages: advancedSteps(current, next, owner, candidate.id, received.id),
    };
    return { state, set: handoffTask(next.stage, owner), wakes: [await handoffWake(ctx, task, next.stage, owner)], skipped };
  }
  return { ...(await readyHandoff(ctx, task, { ...route, state: { ...route.state, stages } }, candidate)), skipped };
}
