import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { candidateTestUnits, EnvironmentSnapshot, ProductCommitSha, UnitFingerprint, validateEnvironmentDescription } from '@hornhoof/protocol';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, testParts, testRuns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { currentCandidate, isTestFilePath, producedCandidate } from './echelons-candidates.js';
import { AUTHOR_CHECK_PASSED } from './echelons-handoff.js';
import { keepCandidateAtTests, takeMainAtTests } from './echelons-main.js';
import type { Submission, submissionOperation } from './echelons-operations.js';
import { changeRoute, type Route } from './echelons-store.js';
import { checkingIdentity, departmentHead, heldCheckingIdentity } from './echelons-assign.js';
import { requireCandidateRun } from './echelons-run.js';
import { captureReview, exactComparison, type Review } from './review-context.js';
import { ReviewSha } from './review-schema.js';
import { scopeKey } from '../testruns/load.js';
import { passedProductPart } from '../testruns/receipts.js';
import { reusableUnits } from '../testruns/reuse-evidence.js';
import { unitKey } from '../testruns/plan-environment.js';
import { move, refuse, type Moved, type Task, type Tx, type Wake } from './engine.js';
import { goesStraightToMain } from './turn-integration.js';
import { turnkeyTeamOf } from './turnkey.js';

export const Verification = z.object({
  candidateId: z.uuid(),
  revision: z.number().int().positive(),
  runIds: z.array(z.uuid()).max(100).default([]),
  delta: z.string().trim().min(1).max(4000).optional(),
}).strict();
export type Verification = z.input<typeof Verification>;
const Verified = z.object({ candidateId: z.uuid(), commit: ReviewSha, routeRevision: z.number().int().positive(), testedRevision: z.number().int().positive(), evidence: z.array(z.object({ runId: z.uuid(), commit: ReviewSha })) });
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'templates' | 'readCompare' | 'readCommit'>>;
type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;

async function boundRuns(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[], testedRevision: number) {
  if (!ids.length || new Set(ids).size !== ids.length) throw refuse(409, 'task_invalid', 'Name distinct completed candidate runs.');
  const candidate = await currentCandidate(db, task, route);
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.companyId, task.companyId), eq(testRuns.taskId, task.id), inArray(testRuns.id, ids)));
  if (runs.length !== ids.length) throw refuse(409, 'task_invalid', 'A test run is missing or belongs to another task.');
  const testerId = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId ?? null;
  for (const run of runs) {
    await requireCandidateRun(db, task, candidate, testedRevision, testerId, run);
    requireFinishedCandidate(run, candidate);
  }
  return { candidate, runs };
}

function requireFinishedCandidate(run: Run, candidate: EchelonCandidate): void {
  if (run.kind !== 'tests' || run.commitSha !== candidate.commit || run.branch !== candidate.branch || !run.finishedAt) throw refuse(409, 'task_changed', 'A run does not verify the current candidate.');
}

function boundProductRequest(run: Run, candidate: EchelonCandidate, profile: string): NonNullable<Run['environmentRequest']> {
  const request = run.environmentRequest;
  if (run.command !== '' || !request || request.problem || request.suite || (request.profile !== undefined && request.profile !== profile) || request.baseCommit !== candidate.baseCommit) throw new Error('The run does not prove the bound candidate scope.');
  return request;
}

function matchesProductSnapshot(snapshot: EnvironmentSnapshot, run: Run, candidate: EchelonCandidate, request: NonNullable<Run['environmentRequest']>, profile: string): boolean {
  const { description } = snapshot, scope = description.repositoryScope;
  return snapshot.candidate?.baseCommit === candidate.baseCommit && snapshot.profile === profile && description.commitSha === candidate.commit && run.environmentHash === description.manifestHash
    && scope.companyId === run.companyId && scope.repositoryOwnerId === run.departmentId && scopeKey(scope) === scopeKey(request.repositoryScope);
}

async function candidateProductSnapshot(run: Run, candidate: EchelonCandidate): Promise<EnvironmentSnapshot> {
  try {
    const snapshot = EnvironmentSnapshot.parse(run.environmentSnapshot);
    const { description } = snapshot;
    const profile = description.manifest.execution?.fullRun?.profile ?? description.manifest.defaultProfile;
    const request = boundProductRequest(run, candidate, profile);
    if (!matchesProductSnapshot(snapshot, run, candidate, request, profile)) throw new Error('The run does not prove the bound candidate scope.');
    await validateEnvironmentDescription(description);
    candidateTestUnits(snapshot);
    return snapshot;
  } catch { throw refuse(409, 'task_invalid', 'Tests needs the bound base/final fingerprints and valid product environment evidence.'); }
}

const ReusedUnit = UnitFingerprint.safeExtend({ runId: z.uuid(), commitSha: ProductCommitSha });
function requireReuseCache(cache: Run['fileCache'], count: number): void {
  if ((cache?.reused ?? 0) !== count || (count && (cache?.mode !== 'cached' || cache.preparationReused))) throw refuse(409, 'task_invalid', 'The run has no complete per-unit reuse evidence.');
}

function reusedCandidateUnits(run: Run, snapshot: EnvironmentSnapshot): z.infer<typeof ReusedUnit>[] {
  const cache = run.fileCache, units = z.array(ReusedUnit).safeParse(cache?.reusedUnits ?? []);
  if (!units.success) throw refuse(409, 'task_invalid', 'The run has no complete per-unit reuse evidence.');
  requireReuseCache(cache, units.data.length);
  const prints = new Map(snapshot.candidate!.fingerprints.map(unit => [unitKey(unit), unit.fingerprint]));
  if (units.data.some(unit => prints.get(unitKey(unit)) !== unit.fingerprint || unit.runId === run.id)) throw refuse(409, 'task_invalid', 'The reused unit does not have the final influencing fingerprint and a prior source.');
  return units.data;
}
type Selection = NonNullable<Part['environmentSelection']>['selection'];

function selectedUnits(selection: Selection): string[] {
  const suites = selection.kind === 'batch' ? selection.selections : selection.kind === 'suite' ? [selection] : [];
  return suites.flatMap(suite => suite.files.map(file => unitKey({ suiteId: suite.suiteId, file })));
}

function exactUnits(actual: string[], expected: Set<string>): boolean {
  return actual.length === expected.size && new Set(actual).size === actual.length && actual.every(key => expected.has(key));
}

function completeCandidateSelection(snapshot: EnvironmentSnapshot, parts: Part[], reused: z.infer<typeof ReusedUnit>[]): void {
  const units = candidateTestUnits(snapshot), expected = new Set(units.map(unitKey));
  const selections = parts.map(part => part.environmentSelection!.selection);
  const actual = [...reused.map(unitKey), ...selections.flatMap(selectedUnits)];
  if (!exactUnits(actual, expected)) throw refuse(409, 'task_invalid', 'The receipts do not cover every applicable candidate test unit exactly.');
  const suites = new Set(units.map(unit => unit.suiteId));
  const expectedFinals = new Set(snapshot.description.manifest.suites.filter(suite => suites.has(suite.id) && suite.finalChecks?.length).map(suite => suite.id));
  const finals = selections.flatMap(selection => selection.kind === 'final' ? [selection.suiteId] : []);
  if (!exactUnits(finals, expectedFinals)) throw refuse(409, 'task_invalid', 'The candidate is missing an applicable post-suite check.');
}

function requireCompleteParts(parts: Part[], run: Run, task: Task, candidate: EchelonCandidate): void {
  const complete = parts.length === run.parts && parts.every((part, i) => part.companyId === task.companyId && part.part === i + 1 && part.status === 'passed' && part.commit === candidate.commit && part.exitCode === 0 && part.error === null);
  if (!complete) throw refuse(409, 'task_invalid', 'A run has incomplete, failed or mismatched parts and no complete reuse proof.');
}

/* Server-owned run and part rows prove the same final source; a status label alone proves nothing. */
export async function candidateRunEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[], testedRevision = route.revision) {
  const { candidate, runs } = await boundRuns(db, task, route, ids, testedRevision);
  for (const run of runs) {
    if (run.status !== 'passed') throw refuse(409, 'task_changed', 'A run did not pass.');
    const snapshot = await candidateProductSnapshot(run, candidate);
    const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
    requireCompleteParts(parts, run, task, candidate);
    for (const part of parts) {
      if (!passedProductPart(snapshot, part)) throw refuse(409, 'task_invalid', 'A passed part has no valid receipt for its assigned candidate selection.');
    }
    const reused = reusedCandidateUnits(run, snapshot);
    if ((await reusableUnits(db, snapshot.description.repositoryScope, reused)).length !== reused.length) throw refuse(409, 'task_invalid', 'A reused unit has no valid original source receipt.');
    completeCandidateSelection(snapshot, parts, reused);
  }
  return runs.map(run => ({ runId: run.id, commit: candidate.commit }));
}

const INFRASTRUCTURE = new Set(['no_machine', 'clone_failed', 'files_failed', 'timeout', 'cancelled', 'machine_restarted', 'machine_offline', 'machine_disconnected', 'subscription_removed', 'no_repository', 'commit_unavailable', 'runtime_missing', 'isolation_missing']);

function requireFailedParts(run: Run, parts: Part[]): void {
  if (!run.parts || parts.length !== run.parts) throw refuse(409, 'task_invalid', 'A failed check needs complete part results.');
}

function requireFailedPart(part: Part, index: number, task: Task, candidate: EchelonCandidate): void {
  if (part.companyId !== task.companyId || part.part !== index + 1 || !['passed', 'failed'].includes(part.status) || !part.finishedAt || (part.commit !== null && part.commit !== candidate.commit)) throw refuse(409, 'task_changed', 'A failed part is incomplete or belongs to another source.');
}

function partFailure(part: Part, run: Run, candidate: EchelonCandidate): 'content' | 'infrastructure' | null {
  if (part.status === 'passed') return null;
  if (run.status === 'passed') throw refuse(409, 'task_invalid', 'The run and failed part disagree.');
  if (INFRASTRUCTURE.has(part.error ?? '')) return 'infrastructure';
  if (part.commit !== candidate.commit || part.exitCode === null || part.exitCode === 0) throw refuse(409, 'task_invalid', 'A content failure needs the checked candidate and failing process result.');
  return 'content';
}

async function failureKind(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[]): Promise<'content' | 'infrastructure'> {
  const { candidate, runs } = await boundRuns(db, task, route, ids, route.revision);
  const failures: ('content' | 'infrastructure')[] = [];
  for (const run of runs) {
    if (!['failed', 'passed', 'stopped'].includes(run.status)) throw refuse(409, 'task_invalid', 'The reported check has not ended.');
    const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
    requireFailedParts(run, parts);
    for (const [index, part] of parts.entries()) {
      requireFailedPart(part, index, task, candidate);
      const kind = partFailure(part, run, candidate);
      if (kind) failures.push(kind);
    }
  }
  if (!failures.length) throw refuse(409, 'task_invalid', 'No failed check was reported.');
  return failures.includes('content') ? 'content' : 'infrastructure';
}

async function failedTestsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, input: z.output<typeof Verification>): Promise<Moved> {
  const kind = await failureKind(ctx.db, task, route, input.runIds);
  const headId = kind === 'content' ? await departmentHead(ctx.db, task) : null;
  const wakes = headId ? [{ agentId: headId, taskId: task.id, why: 'blocked' as const, text: summary }] : [];
  const state: Route['state'] = { ...route.state, phase: 'escalated', stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, reason: 'tests_failed' } : step) };
  const row = await move(ctx, task, { status: kind === 'content' ? 'blocked' : 'working', assigneeAgentId: kind === 'content' ? null : agentId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { failedVerification: { kind, candidateId: input.candidateId, routeRevision: route.revision, runIds: input.runIds } },
    ...(kind === 'content' ? { returned: true as const } : {}),
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, await currentCandidate(tx, task, route));
    if (await failureKind(tx, task, route, input.runIds) !== kind) throw refuse(409, 'task_changed', 'The failed check changed.');
    if (kind === 'content') await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

/* A result that joins its department's open turn is checked by named local checks here: the release runs the full suite
   once on its exact commit. One that goes to its own main line straight needs its completed candidate runs. */
async function verifiedRunEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, ids: string[], testedRevision = route.revision) {
  if (!ids.length) {
    if (await goesStraightToMain(db, task)) throw refuse(409, 'task_invalid', 'Direct main integration needs completed candidate run_tests evidence.');
    return [];
  }
  return candidateRunEvidence(db, task, route, ids, testedRevision);
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
  if (!deltaPaths.length || !deltaPaths.every(isTestFilePath)) {
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
  const candidate = producedCandidate(route, identity, review, new Set([...parent.paths, ...deltaPaths]));
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
  if (step.status === 'skipped' && step.reason !== AUTHOR_CHECK_PASSED) return step;
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

async function requireContentFailureIfRuns(db: Ctx['db'] | Tx, task: Task, route: Route, runIds: string[]): Promise<void> {
  if (runIds.length && (await failureKind(db, task, route, runIds)) !== 'content') {
    throw refuse(409, 'task_invalid', 'An infrastructure failure stays at Tests; return to Development only for a source defect.');
  }
}

async function returnCandidateToExecutor(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, input: z.output<typeof Verification> & { delta: string }): Promise<Moved> {
  await requireContentFailureIfRuns(ctx.db, task, route, input.runIds);
  const candidate = await currentCandidate(ctx.db, task, route);
  const executorId = await availableExecutor(ctx.db, task);
  const state = returnedState(route, executorId, candidate.id);
  const wakes = [await returnWake(ctx.db, task, executorId, input.delta)];
  const row = await move(ctx, task, { status: executorId ? 'open' : 'waiting', assigneeAgentId: executorId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, returned: true,
    data: { rework: true, returnedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, fromRevision: route.revision, executorAgentId: executorId, delta: input.delta, runIds: input.runIds } },
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await requireContentFailureIfRuns(tx, task, route, input.runIds);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

function parseTestsVerification(route: Route, value: Verification | undefined): z.output<typeof Verification> {
  const input = Verification.safeParse(value);
  if (!input.success || input.data.candidateId !== route.state.candidateId || input.data.revision !== route.revision) {
    throw refuse(409, 'task_changed', 'Name the exact current candidate and route revision.');
  }
  return input.data;
}

function nonPassingTestsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, input: z.output<typeof Verification>): Promise<Moved> {
  return input.delta !== undefined
    ? returnCandidateToExecutor(ctx, task, route, agentId, summary, { ...input, delta: input.delta })
    : failedTestsReport(ctx, task, route, agentId, summary, input);
}

export async function testsReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, value: Verification | undefined, done = true): Promise<Moved> {
  if (task.assigneeAgentId !== agentId || route.state.phase !== 'active') throw refuse(403, 'task_not_yours', 'Only the current Tests owner can verify this candidate.');
  const input = parseTestsVerification(route, value);
  await requireTestsIdentity(ctx.db, task, route);
  if (!done) return nonPassingTestsReport(ctx, task, route, agentId, summary, input);
  if (input.delta !== undefined) throw refuse(400, 'task_invalid', 'A passing Tests report cannot carry a return delta.');
  const headId = await departmentHead(ctx.db, task);
  const evidence = await verifiedRunEvidence(ctx.db, task, route, input.runIds);
  const candidate = await currentCandidate(ctx.db, task, route);
  const wakes = [{ agentId: headId, taskId: task.id, why: 'reviewed' as const }];
  const state: Route['state'] = { ...route.state, phase: 'ready', assignment: null, stages: route.state.stages.map(step => step.stage === 'tests' ? { ...step, status: 'complete', candidateId: candidate.id } : step) };
  const row = await move(ctx, task, { status: 'open', assigneeAgentId: headId, silent: 0 }, {
    kind: 'report', actor: { agentId }, text: summary, data: { verifiedCandidate: { candidateId: candidate.id, commit: candidate.commit, routeRevision: route.revision + 1, testedRevision: route.revision, evidence } }, returned: true,
  }, async tx => {
    await heldCheckingIdentity(tx, task, route, candidate);
    await verifiedRunEvidence(tx, task, route, input.runIds);
    await changeRoute(tx, route, state);
  }, wakes);
  return { task: row, wakes };
}

async function requireTestsIdentity(db: Reader['db'], task: Task, route: Route): Promise<void> {
  const candidate = await currentCandidate(db, task, route);
  await checkingIdentity({ db }, task, route, candidate);
}

function matchesTestsReport(proof: z.infer<typeof Verified>, eventAgent: string | null | undefined, tester: string | null | undefined, candidate: EchelonCandidate, revision: number): boolean {
  return eventAgent === tester && proof.candidateId === candidate.id && proof.commit === candidate.commit && proof.routeRevision === revision && proof.evidence.every(run => run.commit === candidate.commit);
}

/* What Tests proved of the candidate; nothing where the route of its department has no Tests. */
export async function testedEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, candidate: EchelonCandidate, verifiedRevision = route.revision) {
  return route.state.stages.some(step => step.stage === 'tests' && step.status !== 'skipped') ? verifiedCandidateEvidence(db, task, route, candidate, verifiedRevision) : [];
}

export async function verifiedCandidateEvidence(db: Ctx['db'] | Tx, task: Task, route: Route, candidate: EchelonCandidate, verifiedRevision = route.revision) {
  const [event] = await db.select({ data: taskEvents.data, agentId: taskEvents.agentId }).from(taskEvents)
    .where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'), sql`${taskEvents.data} ? 'verifiedCandidate'`)).orderBy(desc(taskEvents.id)).limit(1);
  const proof = Verified.safeParse(event?.data.verifiedCandidate);
  const tester = route.state.stages.find(step => step.stage === 'tests')?.ownerAgentId;
  if (!proof.success || !matchesTestsReport(proof.data, event?.agentId, tester, candidate, verifiedRevision)) throw refuse(409, 'task_changed', 'The current candidate has no valid Tests report.');
  return verifiedRunEvidence(db, task, route, proof.data.evidence.map(run => run.runId), proof.data.testedRevision);
}
