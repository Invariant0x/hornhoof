import { posix } from 'node:path';
import type { EchelonCandidate, EchelonStage, EchelonStep, HandedCandidate } from '@hornhoof/protocol/echelons';
import type { Ctx } from '../../app.js';
import type { Route, SkippedCheck } from './echelons-store.js';
import { checkerFor, departmentHead, NO_DEPARTMENT_CHECKER, uncheckable } from './echelons-assign.js';
import type { CheckerIdentity } from './echelons-policy.js';
import { refuse, type Task, type Wake } from './engine.js';
import type { Review } from './review-context.js';

export const AUTHOR_CHECK_PASSED = 'author_check_passed';

function isCodeCandidate(candidate: HandedCandidate): candidate is EchelonCandidate {
  return 'commit' in candidate && 'paths' in candidate;
}

function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(path => posix.matchesGlob(path, 'docs/**'));
}

function recordPassedAt(commit: string, record?: Review['quality']['record']): record is NonNullable<Review['quality']['record']> {
  return Boolean(record && record.checkCommit === commit);
}

function crapUnderTen(crap: number | null): boolean {
  return crap !== null && crap < 10;
}

function passedCodeQuality(commit: string, review?: Review): boolean {
  if (!review || review.quality.status !== 'passed') return false;
  return recordPassedAt(commit, review.quality.record) && crapUnderTen(review.quality.record.numbers.worstCrap);
}

function passedReceiptPart(commit: string, part: NonNullable<Review['quality']['record']>['receipt']['parts'][number]): boolean {
  return part.status === 'passed' && part.commit === commit && part.exitCode === 0 && !part.hasError;
}

function allStagesClear(stages: NonNullable<Review['quality']['record']>['stages']): boolean {
  return stages.length === 6 && stages.every(stage => stage.status === 'passed' || stage.status === 'unavailable');
}

function passedDocsReceipt(commit: string, record: NonNullable<Review['quality']['record']>): boolean {
  const { receipt, stages, numbers } = record;
  const partsOk = receipt.status === 'passed' && receipt.parts.length > 0 && receipt.parts.every(part => passedReceiptPart(commit, part));
  return record.checkCommit === commit && partsOk && allStagesClear(stages) && (numbers.worstCrap === null || numbers.worstCrap < 10);
}

function passedDocsQuality(commit: string, review?: Review): boolean {
  if (passedCodeQuality(commit, review)) return true;
  const record = review?.quality.record;
  return review?.quality.status === 'partial' && Boolean(record && passedDocsReceipt(commit, record));
}

function lowRiskCodeChange(task: Task, review?: Review): boolean {
  return Boolean(task.small || (review?.source && review.source.cleanCherryPick));
}

function shouldSkipCodeReview(task: Task, route: Route, candidate: HandedCandidate, review?: Review): boolean {
  if (route.state.resultKind !== 'code' || route.state.stage !== 'development' || !isCodeCandidate(candidate)) return false;
  if (isDocsOnly(candidate.paths)) return passedDocsQuality(candidate.commit, review);
  return lowRiskCodeChange(task, review) && passedCodeQuality(candidate.commit, review);
}

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
async function readyHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate): Promise<Omit<Handoff, 'skipped'>> {
  const headId = await departmentHead(ctx.db, task);
  const state: Route['state'] = { ...route.state, phase: 'ready', candidateId: candidate.id, assignment: null,
    stages: route.state.stages.map(step => step.stage === route.state.stage ? { ...step, status: 'complete', candidateId: candidate.id } : step),
  };
  return { state, set: { status: 'open', assigneeAgentId: headId, silent: 0 }, wakes: [{ agentId: headId, taskId: task.id, why: 'reviewed' }] };
}

/* skipped: the checks passed over on the way, as nobody in the department can do them or author-check cleared Review. */
type Handoff = { state: Route['state']; set: Partial<Task>; wakes: Wake[]; skipped: SkippedCheck[] };

function markStageSkipped(stages: EchelonStep[], stage: EchelonStage, reason: EchelonStep['reason']): EchelonStep[] {
  return stages.map(step => step.stage === stage ? { ...step, status: 'skipped', reason, ownerAgentId: null } : step);
}

async function chosenNextOwner(
  ctx: Pick<Ctx, 'db'>,
  task: Task,
  route: Route,
  candidate: HandedCandidate,
  next: EchelonStep,
): Promise<{ skipped: true } | { skipped: false; owner: CheckerIdentity | null }> {
  const ability = route.state.abilities[next.stage];
  if (!ability) throw refuse(409, 'task_invalid', 'This stage needs its authorized work assignment.');
  const owner = await checkerFor(ctx, task, candidate.producedBy, ability, next.ownerAgentId);
  if (!owner && await uncheckable(ctx.db, task, next.stage, ability, route.state.security)) return { skipped: true };
  return { skipped: false, owner };
}

export async function forwardHandoff(ctx: Pick<Ctx, 'db'>, task: Task, route: Route, candidate: HandedCandidate, review?: Review): Promise<Handoff> {
  const at = route.state.stages.findIndex(step => step.stage === route.state.stage);
  const ahead = route.state.stages.slice(at + 1).filter(step => step.status !== 'skipped');
  if (!ahead.length && route.state.stage === 'tests') throw refuse(409, 'task_invalid', 'Tests must verify the final candidate before integration.');
  const skipped: SkippedCheck[] = [];
  let stages = route.state.stages;
  for (const next of ahead) {
    if (next.stage === 'review' && shouldSkipCodeReview(task, route, candidate, review)) {
      stages = markStageSkipped(stages, 'review', AUTHOR_CHECK_PASSED);
      skipped.push({ stage: 'review', reason: AUTHOR_CHECK_PASSED });
      continue;
    }
    const chosen = await chosenNextOwner(ctx, task, route, candidate, next);
    if (chosen.skipped) {
      stages = markStageSkipped(stages, next.stage, NO_DEPARTMENT_CHECKER);
      skipped.push(next.stage);
      continue;
    }
    const current: Route = { ...route, state: { ...route.state, stages } };
    const state: Route['state'] = { ...route.state, stage: next.stage, phase: chosen.owner ? 'active' : 'waiting', candidateId: candidate.id, assignment: chosen.owner,
      stages: advancedSteps(current, next, chosen.owner, candidate.id),
    };
    return { state, set: handoffTask(next.stage, chosen.owner), wakes: [await handoffWake(ctx, task, next.stage, chosen.owner)], skipped };
  }
  return { ...(await readyHandoff(ctx, task, { ...route, state: { ...route.state, stages } }, candidate)), skipped };
}
