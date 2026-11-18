import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents } from '../../db/schema.js';
import { currentCandidate, producedCandidate } from './echelons-candidates.js';
import { changeRoute, type Route } from './echelons-store.js';
import { checkingIdentity, departmentHead, heldCheckingIdentity } from './echelons-assign.js';
import { isTestPath, RepoPath, ReviewSha } from './review-schema.js';
import { captureReview, exactComparison, type Review } from './review-context.js';
import { repoAt } from '../departments/repository.js';
import { keepCandidateAtTests, takeMainAtTests } from './echelons-main.js';
import type { Submission, submissionOperation } from './echelons-operations.js';
import { turnkeyTeamOf } from './turnkey.js';
import { move } from './engine.js';
import { refuse, type Moved, type Task, type Tx, type Wake } from './state.js';

/* An agent whose tool list an earlier build gave still names its test runs, as that build asked: they are taken and left out
   until the next release, so its report does not fail on a field it was told to send. */
export const Verification = z.object({
  candidateId: z.uuid(), revision: z.number().int().positive(),
  delta: z.string().trim().min(1).max(4000).optional().describe('Source defect to return to Development without cancelling the task.'),
  runIds: z.array(z.uuid()).max(100).optional().describe('Left out: Tests checks the candidate locally and names no test runs.'),
}).strict();
export type Verification = z.input<typeof Verification>;
/* Reports made before checks went local also name test runs, which are left out. */
const Verified = z.object({ candidateId: z.uuid(), commit: ReviewSha, routeRevision: z.number().int().positive() });
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;

/* A failed check goes to the head with the candidate: Tests checks it locally, and only the release runs the full suite. */
async function failedTestsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, candidate: EchelonCandidate): Promise<Moved> {
  const headId = await departmentHead(ctx.db, task);
  const wakes = [{ agentId: headId, taskId: task.id, why: 'blocked' as const, text: summary }];
  const state: Route['state'] = { ...route.state, phase: 'escalated', stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, reason: 'tests_failed' } : step) };
  const row = await move(ctx, task, { status: 'blocked', assigneeAgentId: null, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { failedVerification: { candidateId: candidate.id, routeRevision: route.revision } }, returned: true,
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

async function readDeltaPaths(ctx: Reader, task: Task, fromCommit: string, toCommit: string): Promise<string[] | null> {
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]) : null;
  if (!found || !ctx.readCompare) return null;
  try {
    const compared = await ctx.readCompare(found.repo, { base: fromCommit, head: toCommit }, 10_000);
    return exactComparison(compared, fromCommit, toCommit) ? [...new Set(compared.paths)] : null;
  } catch { return null; }
}

function requireSameRepairLine(parent: EchelonCandidate, review: Review): string {
  if (review.branch !== parent.branch || review.source?.baseCommit !== parent.baseCommit) {
    throw refuse(409, 'task_changed', 'A test repair at Tests must stay in the candidate branch on the same base commit.');
  }
  if (!review.commit || review.commit === parent.commit) throw refuse(409, 'task_invalid', 'Push a new test-only commit on the candidate branch before submitting at Tests.');
  return review.commit;
}

async function requireTestOnlyDelta(ctx: Reader, task: Task, parent: EchelonCandidate, review: Review): Promise<string[]> {
  const head = requireSameRepairLine(parent, review);
  const deltaPaths = await readDeltaPaths(ctx, task, parent.commit, head);
  if (!deltaPaths) throw refuse(409, 'task_changed', 'The test repair commit must include the current candidate commit in its history.');
  if (!deltaPaths.length || !deltaPaths.every(path => RepoPath.safeParse(path).success && isTestPath(path))) {
    throw refuse(409, 'task_invalid', 'Tests may submit only test-file changes in the candidate branch; return the candidate with delta when src/** changes are needed.');
  }
  return deltaPaths;
}

export async function submitAtTests(ctx: Reader, agentId: string, task: Task, route: Route, input: Submission, operation: ReturnType<typeof submissionOperation>): Promise<Moved> {
  const parent = await currentCandidate(ctx.db, task, route);
  if (input.review?.baseCommit && input.review.baseCommit !== parent.baseCommit) return takeMainAtTests(ctx, agentId, task, route, input, operation);
  const identity = await checkingIdentity(ctx, task, route, parent);
  const review = await captureReview(ctx, { ...task, executorAgentId: agentId }, input.review ?? { baseCommit: parent.baseCommit }, parent.branch);
  const deltaPaths = await requireTestOnlyDelta(ctx, task, parent, review);
  const candidate = producedCandidate(route, identity, review);
  return keepCandidateAtTests(ctx, agentId, task, route, parent, identity, candidate, review, input, operation, {
    testRepair: { from: parent.commit, to: candidate.commit, paths: deltaPaths },
  });
}

function executorInScope(owner: typeof agents.$inferSelect | undefined, task: Task): owner is typeof agents.$inferSelect {
  return Boolean(owner?.subscriptionId && owner.kind !== 'assistant' && owner.departmentId === task.departmentId && (!owner.productId || owner.productId === task.productId));
}

async function availableExecutor(db: Reader['db'], task: Task): Promise<string | null> {
  if (!task.executorAgentId) return null;
  const [owner] = await db.select().from(agents).where(and(eq(agents.id, task.executorAgentId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return executorInScope(owner, task) && !(await turnkeyTeamOf(db, task.companyId, owner.id)) ? owner.id : null;
}

function resetStepForReturn(step: Route['state']['stages'][number], executorId: string | null, candidateId: string): Route['state']['stages'][number] {
  if (step.stage === 'architecture') return step;
  if (step.stage === 'development') {
    return { ...step, status: executorId ? 'active' : 'pending', ownerAgentId: executorId, reason: executorId ? null : 'eligible_owner_required', inputCandidateId: candidateId };
  }
  if (step.status === 'skipped') return step;
  return { ...step, status: 'pending', reason: null, inputCandidateId: null, candidateId: null };
}

function returnedState(route: Route, executorId: string | null, candidateId: string): Route['state'] {
  return {
    ...route.state, stage: 'development', phase: executorId ? 'active' : 'waiting', candidateId, assignment: null,
    stages: route.state.stages.map(step => resetStepForReturn(step, executorId, candidateId)),
  };
}

async function returnWake(db: Reader['db'], task: Task, executorId: string | null, delta: string): Promise<Wake> {
  if (executorId) return { agentId: executorId, taskId: task.id, why: 'assigned', note: `Returned from Tests for source repair: ${delta}` };
  return { agentId: await departmentHead(db, task), taskId: task.id, why: 'blocked', text: `Tests returned #${task.number} for source repair (${delta}), and Development needs an available executor.` };
}

async function returnCandidateToExecutor(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, input: z.output<typeof Verification> & { delta: string }): Promise<Moved> {
  const candidate = await currentCandidate(ctx.db, task, route);
  const executorId = await availableExecutor(ctx.db, task);
  const state = returnedState(route, executorId, candidate.id);
  const wakes = [await returnWake(ctx.db, task, executorId, input.delta)];
  const row = await move(ctx, task, { status: executorId ? 'open' : 'waiting', assigneeAgentId: executorId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, returned: true,
    data: { rework: true, returnedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, fromRevision: route.revision, executorAgentId: executorId, delta: input.delta } },
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

async function failedVerificationReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, input: z.output<typeof Verification>, candidate: EchelonCandidate): Promise<Moved> {
  if (input.delta === undefined) return failedTestsReport(ctx, task, route, agentId, summary, candidate);
  return returnCandidateToExecutor(ctx, task, route, agentId, summary, { ...input, delta: input.delta });
}

export async function testsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: Verification | undefined, done = true): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current Tests owner can verify this candidate.');
  const input = Verification.safeParse(value);
  if (!input.success || input.data.candidateId !== route.state.candidateId || input.data.revision !== route.revision) throw refuse(409, 'task_changed', 'Name the exact current candidate and route revision.');
  const candidate = await currentCandidate(ctx.db, task, route);
  await checkingIdentity({ db: ctx.db }, task, route, candidate);
  if (!done) return failedVerificationReport(ctx, task, route, agentId, summary, input.data, candidate);
  if (input.data.delta !== undefined) throw refuse(400, 'task_invalid', 'A passing Tests report cannot carry a return delta.');
  const headId = await departmentHead(ctx.db, task);
  const wakes = [{ agentId: headId, taskId: task.id, why: 'reviewed' as const }];
  const state: Route['state'] = { ...route.state, phase: 'ready', assignment: null, stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, status: 'complete', candidateId: candidate.id } : step) };
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: headId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { verifiedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, testedRevision: route.revision } }, returned: true,
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

/* The current candidate has its Tests owner's report, where the route of its department has Tests. */
export async function requireTestsReport(db: Ctx['db'] | Tx, task: Task, route: Route, candidate: EchelonCandidate, verifiedRevision = route.revision): Promise<void> {
  if (!route.state.stages.some(step => step.stage === 'tests' && step.status !== 'skipped')) return;
  const [event] = await db.select({ data: taskEvents.data, agentId: taskEvents.agentId }).from(taskEvents)
    .where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'), sql`${taskEvents.data} ? 'verifiedCandidate'`)).orderBy(desc(taskEvents.id)).limit(1);
  const tester = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId;
  if (!provesCandidate(event, tester, candidate, verifiedRevision)) throw refuse(409, 'task_changed', 'The current candidate has no valid Tests report.');
}

/* A report proves the candidate when the Tests owner made it on the candidate's commit at that route revision. */
function provesCandidate(event: { data: Record<string, unknown>; agentId: string | null } | undefined, tester: string | null | undefined, candidate: EchelonCandidate, revision: number): boolean {
  const proof = Verified.safeParse(event?.data.verifiedCandidate);
  return proof.success && event?.agentId === tester && proof.data.candidateId === candidate.id && proof.data.commit === candidate.commit && proof.data.routeRevision === revision;
}
