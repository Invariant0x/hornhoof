import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { taskEvents, taskRoutes, tasks } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { confirmAutonomousMainAcceptance, verifyAutonomousMainAcceptance } from './autonomous-release.js';
import { commitApprovalRequired, exactCommitApproval } from './commit-approval.js';
import { NO_DEPARTMENT_CHECKER } from './echelons-assign.js';
import { currentCandidate } from './echelons-candidates.js';
import { AUTHOR_CHECK_PASSED, changeRoute, skippedAuthorReview, type Route } from './route-records.js';
import { REVIEW_SKIP_ENABLED, requireAuthorReviewSkip } from './author-check.js';
import { reopenAuthorReview } from './echelons-handoff.js';
import { requireTestsReport } from './echelons-tests.js';
import { requireTaskHead } from './echelons-update.js';
import { giver, refuse, type Moved, type Task, type Tx } from './state.js';
import { move } from './transitions.js';
import { heldLineage } from '../testruns/compare.js';
import { headOf, integrationTarget, requireInTurn, requireSameTurn, type IntegrationTarget } from './turn-integration.js';
import { ReviewSha } from './review-schema.js';

export const AcceptanceInput = z.object({ candidateId: z.uuid(), revision: z.number().int().positive(), integrationCommit: ReviewSha }).strict();
export type AcceptanceInput = z.infer<typeof AcceptanceInput>;

type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;

export function requiredStagesComplete(route: Route): boolean {
  /* Keep the record of accepted work readable. New acceptance always checks any author-based skip. */
  const mayBeSkipped = (step: Route['state']['stages'][number]) => {
    if (step.stage === 'security' && route.state.security.required) return false;
    if (step.stage === 'review' && step.reason === AUTHOR_CHECK_PASSED) {
      return (REVIEW_SKIP_ENABLED || route.state.phase === 'done')
        && route.state.resultKind === 'code' && step.inputCandidateId === route.state.candidateId;
    }
    return step.reason === NO_DEPARTMENT_CHECKER || (step.stage !== 'review' && step.stage !== 'tests');
  };
  return route.state.stages.every(step => step.status === 'complete' || (step.status === 'skipped' && mayBeSkipped(step)));
}

const noMainApproval = () => refuse(403, 'decision_not_allowed', 'The department requires approval of this exact integration commit.');

type ObservedHead = Awaited<ReturnType<Ctx['readCommit']>>;
type Repository = Parameters<Ctx['readCommit']>[0];

/* The branch is at the commit, as the repository says it now. A tag of its name is no branch, as a ref written where the
   branch was deleted would otherwise be. */
function matchesObservedHead(value: ObservedHead, branch: string, commit: string): boolean {
  return !('problem' in value) && !value.tag && value.branch === branch && value.commitSha === commit;
}

async function requireInclusion(ctx: Reader, repository: Repository, candidate: string, integration: string): Promise<void> {
  if (integration === candidate) return;
  const comparison = await ctx.readCompare?.(repository, { base: candidate, head: integration }, 10_000);
  if (!comparison || !heldLineage(comparison, candidate, integration)) throw new Error('inclusion unproved');
}

type TurnTarget = IntegrationTarget & { turn: NonNullable<IntegrationTarget['turn']> };
/* What an acceptance into a turn records: the candidate's own commit there, or the merge a take-in brought it there in. */
const TakeInAcceptance = z.object({ candidateId: z.uuid(), commit: ReviewSha, routeRevision: z.number().int().positive(), integration: z.object({ branch: z.string(), commit: ReviewSha }) });

/* Whether the accepted result of a code task proves that its checked candidate, at merge on the candidate branch, joined the
   turn: its route is done with every required stage, and its last report accepted that very candidate into the turn branch. */
async function acceptedAt(db: Ctx['db'], other: Task, target: TurnTarget, branch: string, merge: string): Promise<boolean> {
  const [route] = await db.select().from(taskRoutes).where(and(eq(taskRoutes.taskId, other.id), eq(taskRoutes.companyId, other.companyId)));
  if (!route || route.state.resultKind !== 'code' || route.state.phase !== 'done' || !requiredStagesComplete(route)) return false;
  const [report] = await db.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.taskId, other.id), eq(taskEvents.companyId, other.companyId), eq(taskEvents.kind, 'report'))).orderBy(desc(taskEvents.id)).limit(1);
  const accepted = TakeInAcceptance.safeParse(report?.data.acceptedCandidate);
  if (!accepted.success || accepted.data.integration.branch !== target.branch || accepted.data.integration.commit !== merge || accepted.data.routeRevision !== route.revision) return false;
  try {
    const candidate = await currentCandidate(db, other, route);
    if (candidate.id !== accepted.data.candidateId || candidate.commit !== merge || candidate.branch !== branch) return false;
    await requireTestsReport(db, other, route, candidate, route.revision - 1);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return false;
    throw error;
  }
}

/* The task of the department that took this turn into the candidate's branch and joined the turn with that checked merge. */
async function takeInOf(db: Ctx['db'], task: Task, target: TurnTarget, candidate: EchelonCandidate, merge: string): Promise<Task | null> {
  const joined = await db.select().from(tasks).where(and(eq(tasks.companyId, task.companyId), eq(tasks.turnId, target.turn.id), eq(tasks.status, 'done'), ne(tasks.id, task.id),
    sql`exists (select 1 from ${taskEvents} where ${taskEvents.taskId} = ${tasks.id} and ${taskEvents.kind} = 'report' and ${taskEvents.data}->'acceptedCandidate'->>'commit' = ${merge})`));
  for (const other of joined) if (await acceptedAt(db, other, target, candidate.branch, merge)) return other;
  return null;
}

/* A candidate the turn went on from cannot reach it by fast-forward. A take-in merges the turn into the candidate's branch, has
   that merge checked and accepts it into the turn: the candidate is in the turn once that merge holds it and the turn holds the
   merge, and its acceptance names the take-in. */
async function throughTakeIn(ctx: Reader, task: Task, target: TurnTarget, candidate: EchelonCandidate, merge: string) {
  const takeIn = await takeInOf(ctx.db, task, target, candidate, merge);
  if (!takeIn) {
    throw refuse(409, 'task_invalid', `${target.branch} takes a candidate only by fast-forward, so the integration commit is the candidate's own, ${candidate.commit}, or the merge an accepted take-in of ${candidate.branch} brought into ${target.branch}. A merge on ${target.branch} is no checked result: fast-forward ${target.branch} to the candidate, or, where ${target.branch} went on, take it into the candidate and have that checked.`);
  }
  try { await requireInclusion(ctx, target.repo, candidate.commit, merge); }
  catch { throw refuse(409, 'task_changed', `${merge}, which #${takeIn.number} brought into ${target.branch}, does not hold the candidate ${candidate.commit}, or that could not be read.`); }
  await requireInTurn(ctx, target, merge, head => `#${takeIn.number} brought ${merge} into ${target.branch}, which is at ${head} now: fast-forward ${target.branch} to it, then accept this result.`);
  return { branch: target.branch, commit: merge, approval: null, autoProof: null, observedAt: new Date().toISOString(), takeIn: { taskId: takeIn.id, number: takeIn.number } };
}

/* Read-only proof of a fast-forward of the turn branch to the exact candidate, already made through the authorized Git route,
   or of the take-in that brought it there. */
async function intoTurn(ctx: Reader, task: Task, target: TurnTarget, candidate: EchelonCandidate, input: AcceptanceInput) {
  if (input.integrationCommit !== candidate.commit) return throughTakeIn(ctx, task, target, candidate, input.integrationCommit);
  const source = await headOf(ctx, target.repo, candidate.branch);
  if (source !== candidate.commit) throw refuse(409, 'task_changed', 'The source changed after the checks, or it cannot be read.');
  const { branch } = target;
  await requireInTurn(ctx, target, candidate.commit, (head, holdsHead) => holdsHead
    ? `fast-forward ${branch} to the candidate first, then accept it.`
    : `the candidate does not hold ${head}, the head of ${branch}, so ${branch} cannot go to it by fast-forward: take ${branch} into the candidate and have that checked, then fast-forward ${branch} to it and accept it.`);
  return { branch: target.branch, commit: candidate.commit, approval: null, autoProof: null, observedAt: new Date().toISOString() };
}

type AutoProof = Awaited<ReturnType<typeof verifyAutonomousMainAcceptance>>;

/* A recorded approval or autonomous proof, where the department's commit rule requires one. */
async function verifyMainIntegrationApproval(ctx: Reader, task: Task, commit: string): Promise<{ approval: string | null; autoProof: AutoProof }> {
  const approval = await exactCommitApproval(ctx.db, task.companyId, task.id, commit);
  if (approval || !(await commitApprovalRequired(ctx.db, task.companyId, task.departmentId))) return { approval, autoProof: null };
  const autoProof = await verifyAutonomousMainAcceptance(ctx, task, commit);
  if (!autoProof) throw noMainApproval();
  return { approval: null, autoProof };
}

async function confirmMainApprovalInTx(tx: Tx, task: Task, commit: string, approval: string | null, autoProof: AutoProof): Promise<void> {
  if (approval && await exactCommitApproval(tx, task.companyId, task.id, commit, approval)) return;
  if (autoProof && await confirmAutonomousMainAcceptance(tx, task, commit, autoProof)) return;
  if (approval || autoProof || await commitApprovalRequired(tx, task.companyId, task.departmentId, true)) throw noMainApproval();
}

/* Read-only proof of an integration into a main line of its own, already performed through the authorized Git route. */
async function intoMain(ctx: Reader, task: Task, target: IntegrationTarget, candidate: EchelonCandidate, input: AcceptanceInput) {
  const { approval, autoProof } = await verifyMainIntegrationApproval(ctx, task, input.integrationCommit);
  try {
    const source = await ctx.readCommit!(target.repo, { branch: candidate.branch }, 5_000);
    const main = await ctx.readCommit!(target.repo, { branch: target.branch }, 5_000);
    if (!matchesObservedHead(source, candidate.branch, candidate.commit) || !matchesObservedHead(main, target.branch, input.integrationCommit)) throw new Error('stale integration');
    await requireInclusion(ctx, target.repo, candidate.commit, input.integrationCommit);
  } catch { throw refuse(409, 'task_changed', 'The source or integration changed, or candidate inclusion cannot be verified.'); }
  return { branch: target.branch, commit: input.integrationCommit, approval, autoProof, observedAt: new Date().toISOString() };
}

async function observedIntegration(ctx: Reader, task: Task, candidate: EchelonCandidate, input: AcceptanceInput) {
  if (!ctx.config || !ctx.readCommit) throw refuse(409, 'repo_invalid', 'The repository integration cannot be verified.');
  const target = await integrationTarget(ctx, task);
  if (!target) throw refuse(409, 'repo_invalid', 'The result has no repository to verify.');
  const turn = target.turn;
  return { turn, integration: turn ? await intoTurn(ctx, task, { ...target, turn }, candidate, input) : await intoMain(ctx, task, target, candidate, input) };
}

export async function acceptCandidate(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: AcceptanceInput | undefined): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', 'Only the current accepting owner may close this candidate.');
  await requireTaskHead(ctx, task, agentId);
  const input = AcceptanceInput.safeParse(value);
  if (!input.success) throw refuse(400, 'task_invalid', 'Acceptance needs the candidate, route revision and exact integration commit.');
  if (route.state.resultKind !== 'code' || route.state.phase !== 'ready') throw refuse(409, 'task_invalid', 'The required stages have not verified this result.');
  if (input.data.candidateId !== route.state.candidateId || input.data.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact ready candidate and route revision.');
  if (!REVIEW_SKIP_ENABLED && skippedAuthorReview(route.state)) {
    const candidate = await currentCandidate(ctx.db, task, route);
    return reopenAuthorReview(ctx, task, route, candidate, agentId, tx => requireTaskHead({ db: tx }, task, agentId));
  }
  if (!requiredStagesComplete(route)) throw refuse(409, 'task_invalid', 'The required stages have not verified this result.');
  const candidate = await currentCandidate(ctx.db, task, route);
  await requireAuthorReviewSkip(ctx, task, route, candidate);
  await requireTestsReport(ctx.db, task, route, candidate);
  const { turn, integration: { autoProof, ...integration } } = await observedIntegration(ctx, task, candidate, input.data);
  const wakes = giver(task, 'done', agentId, summary);
  const row = await move(ctx, task, { status: 'done', assigneeAgentId: null, closedAt: new Date(), silent: 0, ...(turn ? { turnId: turn.id } : {}) }, {
    kind: 'report', actor: { agentId }, text: summary, data: { done: true, acceptedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, integration } }, returned: true,
  }, async tx => {
    if (turn) await requireSameTurn(tx, task, turn, candidate.commit);
    await requireTaskHead({ db: tx }, task, agentId);
    await requireAuthorReviewSkip({ db: tx, config: ctx.config }, task, route, candidate);
    await requireTestsReport(tx, task, route, candidate);
    if (!turn) await confirmMainApprovalInTx(tx, task, integration.commit, integration.approval, autoProof);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}
