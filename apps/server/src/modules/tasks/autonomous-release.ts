import { EnvironmentSnapshot, validateEnvironmentDescription } from '@hornhoof/protocol';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, autonomousReleases, departments, people, taskEvents, tasks, testParts, testRuns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import { evidenceOf } from '../testruns/evidence.js';
import { coversEveryPart } from '../testruns/github-status.js';
import { scopeKey } from '../testruns/load.js';
import { ranEverything, runScope, scopeSource } from '../testruns/purpose.js';
import { passedProductPart } from '../testruns/receipts.js';
import { currentCandidate } from './echelons-candidates.js';
import { routeOf, type Route } from './echelons-store.js';
import { comment, loadTask, mayAsk, type Moved, type Task, type Tx } from './engine.js';
import { refusePaused } from './pause.js';
import { autonomousTurnReleaseReady } from './releases.js';
import { exactComparison } from './review-context.js';
import { openTurnOf } from './turn-department.js';
import { branchHolds, headOf } from './turn-integration.js';
import { turnkeyTeamOf } from './turnkey.js';

const RELEASE_BRANCH_RE = /^release-\d+\.\d+\.\d+$/;

type QueryDb = Db | Tx;
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;
type FreshnessReader = Partial<Pick<Ctx, 'db' | 'config' | 'readCommit'>> | null;
type Dept = typeof departments.$inferSelect;
type Repo = NonNullable<Awaited<ReturnType<typeof repoAt>>>['repo'];
type Run = typeof testRuns.$inferSelect;
type Part = typeof testParts.$inferSelect;
type Snapshot = EnvironmentSnapshot;
type ScopeAddress = Snapshot['description']['repositoryScope'];

type VerifiedRun = { id: string; number: number };
type VerifiedVerdict = {
  eventId: number | null;
  reviewerAgentId: string;
  reviewerName: string;
  stage: string;
  baseCommitSha: string;
  allowedRunBranches: Set<string>;
  allowedTaskIds?: Set<string> | undefined;
  isTurnkey?: boolean | undefined;
};
type VerifiedProof = { department: Dept; repo: Repo; run: VerifiedRun; verdict: VerifiedVerdict; baseCommitSha: string };
type VerdictRow = { id: number; agentId: string | null; pass: boolean; wrongGoal: boolean; stage: string; reviewedCommit: string };

export type RecordedMainApproval = {
  entryId: string;
  baseCommitSha: string;
  candidateBaseCommitSha: string;
  department: Dept;
  isTurnkey?: boolean | undefined;
};

export type AutonomousReleaseEntry = {
  id: string;
  departmentId: string | null;
  taskId: string | null;
  taskNumber: number;
  agentId: string | null;
  agentName: string;
  commitSha: string;
  baseCommitSha: string;
  testRunId: string | null;
  testRunNumber: number;
  reviewerAgentId: string | null;
  reviewerName: string;
  verdictStage: string;
  createdAt: string;
};

/* Who turns a department's autonomous release on or off: a signed-in person, never an agent or an assistant acting for one,
   who runs that department. The CEO runs every department. */
export async function maySetAutonomousRelease(db: Pick<Db, 'select'>, me: Person, departmentId: string): Promise<boolean> {
  if (me.status !== 'active' || Boolean(me.via) || Boolean(me.assistant)) return false;
  const [row] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.id, me.id), eq(people.companyId, me.companyId), eq(people.status, 'active'), eq(people.isAgent, false)));
  if (!row) return false;
  return me.isOwner || (await accessOf(db, me)).owns?.has(departmentId) === true;
}

/* Whether a department has autonomous release on: a top-level one its own, a product or part the department that holds it. */
export async function isAutonomousReleaseEnabled(db: Pick<QueryDb, 'select'>, departmentId: string): Promise<boolean> {
  const [dept] = await db.select({ parentId: departments.parentId, on: departments.autonomousRelease }).from(departments).where(eq(departments.id, departmentId));
  if (!dept?.parentId) return Boolean(dept?.on);
  const [top] = await db.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, dept.parentId));
  return Boolean(top?.on);
}

export async function hasAutonomousReleaseEntries(db: Pick<QueryDb, 'select'>, companyId: string, departmentId?: string): Promise<boolean> {
  const scope = departmentId ? and(eq(autonomousReleases.companyId, companyId), eq(autonomousReleases.departmentId, departmentId)) : eq(autonomousReleases.companyId, companyId);
  const [row] = await db.select({ id: autonomousReleases.id }).from(autonomousReleases).where(scope).limit(1);
  return Boolean(row);
}

export async function listAutonomousReleases(db: Pick<QueryDb, 'select'>, companyId: string, departmentId?: string): Promise<AutonomousReleaseEntry[]> {
  const scope = departmentId ? and(eq(autonomousReleases.companyId, companyId), eq(autonomousReleases.departmentId, departmentId)) : eq(autonomousReleases.companyId, companyId);
  const rows = await db.select().from(autonomousReleases).where(scope).orderBy(desc(autonomousReleases.createdAt), desc(autonomousReleases.id)).limit(100);
  return rows.map(row => ({
    id: row.id,
    departmentId: row.departmentId,
    taskId: row.taskId,
    taskNumber: row.taskNumber,
    agentId: row.agentId,
    agentName: row.agentName,
    commitSha: row.commitSha,
    baseCommitSha: row.baseCommitSha,
    testRunId: row.testRunId,
    testRunNumber: row.testRunNumber,
    reviewerAgentId: row.reviewerAgentId,
    reviewerName: row.reviewerName,
    verdictStage: row.verdictStage,
    createdAt: row.createdAt.toISOString(),
  }));
}

function validPartAt(part: Part, index: number, companyId: string, commit: string): boolean {
  return part.companyId === companyId && part.part === index + 1 && part.status === 'passed' && part.commit === commit && part.exitCode === 0 && part.error === null;
}

function completeRunParts(parts: Part[], run: Run, companyId: string, commit: string): boolean {
  return run.parts > 0 && parts.length === run.parts && parts.every((part, i) => validPartAt(part, i, companyId, commit));
}

function hasWholeEnvironmentRequest(run: Run): boolean {
  const req = run.environmentRequest;
  return Boolean(req && !req.problem && !req.suite);
}

function matchingRepoScope(repoScope: ScopeAddress, requestedScope: ScopeAddress, companyId: string, departmentId: string): boolean {
  return repoScope.companyId === companyId && repoScope.repositoryOwnerId === departmentId && scopeKey(repoScope) === scopeKey(requestedScope);
}

function matchingSnapshot(run: Run, companyId: string, departmentId: string, commit: string): Snapshot | null {
  if (!hasWholeEnvironmentRequest(run) || !run.environmentRequest) return null;
  const parsed = EnvironmentSnapshot.safeParse(run.environmentSnapshot);
  if (!parsed.success) return null;
  const { description } = parsed.data;
  const commitMatches = description.commitSha === commit && run.environmentHash === description.manifestHash;
  return commitMatches && matchingRepoScope(description.repositoryScope, run.environmentRequest.repositoryScope, companyId, departmentId) ? parsed.data : null;
}

function isFullManifestScope(snapshot: Snapshot, reused: number): boolean {
  const scope = runScope(scopeSource(snapshot), undefined, reused);
  if (!ranEverything(scope) || !snapshot.description.manifest.suites.length) return false;
  return scope.fullProfile === null || scope.profile === scope.fullProfile;
}

async function validFullProductRun(run: Run, parts: Part[], companyId: string, departmentId: string, commit: string): Promise<boolean> {
  const snapshot = matchingSnapshot(run, companyId, departmentId, commit);
  if (!snapshot || !isFullManifestScope(snapshot, run.fileCache?.reused ?? 0)) return false;
  try {
    await validateEnvironmentDescription(snapshot.description);
  } catch {
    return false;
  }
  return parts.every(part => passedProductPart(snapshot, part));
}

function isMainRepository(department: Dept, repo?: Repo): boolean {
  return (department.repoBranch ?? 'main') === 'main' && (!repo || repo.branch === 'main');
}

function isAllowedRunBranch(branch: string | null, allowedRunBranches: Set<string>): boolean {
  return Boolean(branch && (allowedRunBranches.has(branch) || RELEASE_BRANCH_RE.test(branch)));
}

function matchesTurnkeyTaskRun(run: Run, allowedRunBranches: Set<string>, allowedTaskIds?: Set<string>): boolean {
  if (!allowedTaskIds) return true;
  if (run.branch?.startsWith('task-')) return allowedRunBranches.has(run.branch);
  return Boolean(run.taskId && allowedTaskIds.has(run.taskId));
}

function isPassedCommitRun(run: Run, commit: string, allowedRunBranches: Set<string>, allowedTaskIds?: Set<string>): boolean {
  if (run.status !== 'passed' || !run.finishedAt || run.commitSha !== commit) return false;
  return isAllowedRunBranch(run.branch, allowedRunBranches) && matchesTurnkeyTaskRun(run, allowedRunBranches, allowedTaskIds);
}

function hasZeroReusedResults(run: Run): boolean {
  return !run.fileCache || (run.fileCache.mode === 'full' && run.fileCache.reused === 0);
}

function matchesLegacyFullCommand(department: Dept, command: string): boolean {
  return command === department.repoFullTestCommand && coversEveryPart(command);
}

async function isWholeSuiteGreenRun(
  db: QueryDb,
  companyId: string,
  department: Dept,
  commit: string,
  run: Run,
  allowedRunBranches: Set<string>,
  allowedTaskIds?: Set<string>,
): Promise<boolean> {
  if (!isPassedCommitRun(run, commit, allowedRunBranches, allowedTaskIds) || !hasZeroReusedResults(run)) return false;
  const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
  if (!completeRunParts(parts, run, companyId, commit)) return false;
  return run.command === '' ? validFullProductRun(run, parts, companyId, department.id, commit) : matchesLegacyFullCommand(department, run.command);
}

async function newestFailedNumber(db: QueryDb, companyId: string, departmentId: string, commit: string): Promise<number> {
  const [failed] = await db
    .select({ number: testRuns.number })
    .from(testRuns)
    .where(and(eq(testRuns.companyId, companyId), eq(testRuns.departmentId, departmentId), eq(testRuns.kind, 'tests'), eq(testRuns.commitSha, commit), eq(testRuns.status, 'failed')))
    .orderBy(desc(testRuns.number))
    .limit(1);
  return failed?.number ?? 0;
}

async function isCurrentRunEvidence(ctx: FreshnessReader, run: Run, checkFreshness: boolean): Promise<boolean> {
  if (!checkFreshness) return true;
  if (!ctx?.db || !ctx.config || !ctx.readCommit) return false;
  const evidence = await evidenceOf({ db: ctx.db, config: ctx.config, readCommit: ctx.readCommit }, run);
  return evidence.freshness === 'current';
}

/* Condition (a): completed green full run_tests run on that exact 40-char SHA with proves: true. */
async function verifiedFullRun(
  ctx: FreshnessReader,
  db: QueryDb,
  companyId: string,
  department: Dept,
  commit: string,
  checkFreshness: boolean,
  allowedRunBranches: Set<string>,
  allowedTaskIds?: Set<string>,
): Promise<VerifiedRun | null> {
  const failedAfter = await newestFailedNumber(db, companyId, department.id, commit);
  const runs = await db
    .select()
    .from(testRuns)
    .where(and(eq(testRuns.companyId, companyId), eq(testRuns.departmentId, department.id), eq(testRuns.kind, 'tests'), eq(testRuns.commitSha, commit), eq(testRuns.status, 'passed')))
    .orderBy(desc(testRuns.number))
    .limit(25);
  for (const run of runs) {
    if (run.number <= failedAfter) break;
    if ((await isWholeSuiteGreenRun(db, companyId, department, commit, run, allowedRunBranches, allowedTaskIds)) && (await isCurrentRunEvidence(ctx, run, checkFreshness))) {
      return { id: run.id, number: run.number };
    }
  }
  return null;
}

async function repoDepartmentIds(db: QueryDb, companyId: string, repositoryOwnerId: string): Promise<string[]> {
  const children = await db
    .select({ id: departments.id, repoUrl: departments.repoUrl })
    .from(departments)
    .where(and(eq(departments.companyId, companyId), eq(departments.parentId, repositoryOwnerId)));
  return [repositoryOwnerId, ...children.filter(child => !child.repoUrl).map(child => child.id)];
}

/* A result that goes to its own main line straight is on its task branch, on main, or on a release branch. */
function candidateBranchLeadsToMain(taskNumber: number, branch: string): boolean {
  return branch === `task-${taskNumber}` || branch === 'main' || RELEASE_BRANCH_RE.test(branch);
}

function isLiveMainCodeRoute(route: Route): boolean {
  return route.state.resultKind === 'code' && (route.state.phase === 'ready' || (route.state.phase === 'active' && route.state.stage === 'tests'));
}

async function loadCurrentCommitCandidate(db: QueryDb, task: Task, route: Route, commit: string): Promise<EchelonCandidate | null> {
  if (task.status === 'cancelled' || !isLiveMainCodeRoute(route)) return null;
  try {
    const candidate = await currentCandidate(db, task, route);
    return candidate.commit === commit ? candidate : null;
  } catch {
    return null;
  }
}

async function candidateIntegratesToMain(
  db: QueryDb,
  verdictTask: Task,
  route: Route,
  commit: string,
): Promise<{ candidate: EchelonCandidate; allowedRunBranches: Set<string> } | null> {
  const candidate = await loadCurrentCommitCandidate(db, verdictTask, route, commit);
  if (!candidate || !candidateBranchLeadsToMain(verdictTask.number, candidate.branch)) return null;
  return { candidate, allowedRunBranches: new Set<string>(['main', candidate.branch]) };
}

function taskInRepoScope(task: Task, placeIds: string[]): boolean {
  const spot = task.productId ?? task.departmentId;
  return task.status !== 'cancelled' && Boolean(spot && placeIds.includes(spot));
}

/* The task is above the other by its parents, in its company, however far up. */
async function isAncestor(db: QueryDb, ancestor: Task, task: Task): Promise<boolean> {
  const seen = new Set<string>([task.id]);
  let parentId = task.parentId;
  while (parentId && !seen.has(parentId)) {
    if (parentId === ancestor.id) return true;
    seen.add(parentId);
    const [row] = await db.select({ parentId: tasks.parentId }).from(tasks).where(and(eq(tasks.id, parentId), eq(tasks.companyId, task.companyId)));
    parentId = row?.parentId ?? null;
  }
  return false;
}

/* The task that has the verdict asks, or a running coordination task above it by its parents. No other coordination task of
   the repository asks for a verdict on work it does not coordinate: a result that goes to its own main line joins no turn,
   so no turn could tell them apart. */
async function requesterMayAutoApprove(db: QueryDb, askingTask: Task, verdictTask: Task, placeIds: string[]): Promise<boolean> {
  if (!taskInRepoScope(askingTask, placeIds)) return false;
  if (askingTask.id === verdictTask.id) return true;
  if (!(await isAncestor(db, askingTask, verdictTask))) return false;
  const route = await routeOf(db, askingTask);
  return route.state.resultKind === 'coordination' && route.state.phase === 'active';
}

async function commitAuthors(db: QueryDb, verdictTask: Task, askingTask: Task): Promise<Set<string>> {
  const ids = new Set<string>([verdictTask.executorAgentId, verdictTask.id === askingTask.id ? askingTask.executorAgentId : null].filter((id): id is string => Boolean(id)));
  const submitted = await db
    .select({ agentId: taskEvents.agentId, producer: sql<string | null>`${taskEvents.data}->'candidate'->'producedBy'->>'agentId'` })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.companyId, verdictTask.companyId),
        inArray(taskEvents.taskId, [verdictTask.id, askingTask.id]),
        eq(taskEvents.kind, 'submitted'),
      ),
    );
  for (const row of submitted) {
    if (row.agentId) ids.add(row.agentId);
    if (row.producer) ids.add(row.producer);
  }
  return ids;
}

async function activeReviewer(
  db: QueryDb,
  companyId: string,
  agentId: string | null,
  authors: Set<string>,
): Promise<{ reviewerAgentId: string; reviewerName: string } | null> {
  if (!agentId || authors.has(agentId)) return null;
  const [reviewer] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return reviewer ? { reviewerAgentId: agentId, reviewerName: reviewer.name } : null;
}

function stageRowPassedOnCommit(row: VerdictRow, commit: string): boolean {
  return row.pass && !row.wrongGoal && row.reviewedCommit === commit;
}

function allLatestStagesPassed(rows: VerdictRow[], commit: string): Map<string, VerdictRow> | null {
  const latestByStage = new Map<string, VerdictRow>();
  for (const row of rows) {
    if (['review', 'security', 'cleanup'].includes(row.stage)) latestByStage.set(row.stage, row);
  }
  if (!latestByStage.size) return null;
  for (const row of latestByStage.values()) {
    if (!stageRowPassedOnCommit(row, commit)) return null;
  }
  return latestByStage;
}

async function securityStageVerified(db: QueryDb, companyId: string, required: boolean, securityRow: VerdictRow | undefined, authors: Set<string>): Promise<boolean> {
  if (!required) return true;
  return Boolean(securityRow && (await activeReviewer(db, companyId, securityRow.agentId, authors)));
}

function primaryStageRow(latestByStage: Map<string, VerdictRow>): VerdictRow | null {
  return latestByStage.get('review') ?? latestByStage.get('security') ?? null;
}

async function verifiedPrimaryVerdict(
  db: QueryDb,
  verdictTask: Task,
  askingTask: Task,
  route: Route,
  latestByStage: Map<string, VerdictRow>,
  baseCommitSha: string,
  allowedRunBranches: Set<string>,
): Promise<VerifiedVerdict | null> {
  const authors = await commitAuthors(db, verdictTask, askingTask);
  if (!(await securityStageVerified(db, askingTask.companyId, route.state.security.required, latestByStage.get('security'), authors))) return null;
  const primary = primaryStageRow(latestByStage);
  if (!primary) return null;
  const reviewer = await activeReviewer(db, askingTask.companyId, primary.agentId, authors);
  return reviewer ? { eventId: primary.id, stage: primary.stage, ...reviewer, baseCommitSha, allowedRunBranches } : null;
}

async function queryCandidateVerdicts(db: QueryDb, companyId: string, taskId: string, candidateId: string): Promise<VerdictRow[]> {
  return db
    .select({
      id: taskEvents.id,
      agentId: taskEvents.agentId,
      pass: sql<boolean>`(${taskEvents.data}->>'pass') = 'true'`,
      wrongGoal: sql<boolean>`(${taskEvents.data}->>'wrongGoal') = 'true'`,
      stage: sql<string>`coalesce(${taskEvents.data}->>'stage', '')`,
      reviewedCommit: sql<string>`coalesce(${taskEvents.data}->>'reviewedCommit', '')`,
    })
    .from(taskEvents)
    .where(and(eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, taskId), eq(taskEvents.kind, 'verdict'), sql`${taskEvents.data}->>'candidateId' = ${candidateId}`))
    .orderBy(asc(taskEvents.id));
}

async function taskVerdictOnCommit(
  db: QueryDb,
  verdictTask: Task,
  askingTask: Task,
  placeIds: string[],
  commit: string,
): Promise<VerifiedVerdict | null> {
  if (!(await requesterMayAutoApprove(db, askingTask, verdictTask, placeIds))) return null;
  const route = await routeOf(db, verdictTask);
  const eligible = await candidateIntegratesToMain(db, verdictTask, route, commit);
  if (!eligible) return null;
  const rows = await queryCandidateVerdicts(db, verdictTask.companyId, verdictTask.id, eligible.candidate.id);
  const latestByStage = allLatestStagesPassed(rows, commit);
  if (!latestByStage) return null;
  return verifiedPrimaryVerdict(db, verdictTask, askingTask, route, latestByStage, eligible.candidate.baseCommit, eligible.allowedRunBranches);
}

async function candidateTaskIdsOnCommit(db: QueryDb, companyId: string, placeIds: string[], commit: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: taskEvents.taskId })
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(
      and(
        eq(taskEvents.companyId, companyId),
        eq(taskEvents.kind, 'verdict'),
        ne(tasks.status, 'cancelled'),
        inArray(sql<string>`coalesce(${tasks.productId}, ${tasks.departmentId})`, placeIds),
        sql`${taskEvents.data}->>'reviewedCommit' = ${commit}`,
      ),
    )
    .orderBy(asc(taskEvents.id));
  return [...new Set(rows.map(row => row.taskId))];
}

/* Condition (b): independent PASS verdict on that exact 40-char SHA from a main-line task of the same repository. */
async function verifiedIndependentVerdict(db: QueryDb, askingTask: Task, repositoryOwnerId: string, commit: string): Promise<VerifiedVerdict | null> {
  const placeIds = await repoDepartmentIds(db, askingTask.companyId, repositoryOwnerId);
  const taskIds = (await candidateTaskIdsOnCommit(db, askingTask.companyId, placeIds, commit)).sort(
    (a, b) => Number(b === askingTask.id) - Number(a === askingTask.id),
  );
  for (const taskId of taskIds) {
    const verdictTask = taskId === askingTask.id ? askingTask : await loadTask(db, taskId);
    const verified = await taskVerdictOnCommit(db, verdictTask, askingTask, placeIds, commit);
    if (verified) return verified;
  }
  return null;
}

async function verifiedAncestorSha(ctx: Reader, repo: Repo, base: string, head: string): Promise<boolean> {
  if (!ctx.readCompare) return false;
  try {
    const compared = await ctx.readCompare(repo, { base, head }, 10_000);
    return exactComparison(compared, base, head);
  } catch {
    return false;
  }
}

/* Condition (c): the commit is a fast-forward from current origin/main (ahead or identical, never diverged or behind). */
async function verifiedFastForward(ctx: Reader, repo: Repo, commit: string): Promise<string | null> {
  if (repo.branch !== 'main' || !ctx.readCommit) return null;
  try {
    const mainHead = await ctx.readCommit(repo, { branch: 'main' }, 5_000);
    if ('problem' in mainHead) return null;
    return (await verifiedAncestorSha(ctx, repo, mainHead.commitSha, commit)) ? mainHead.commitSha : null;
  } catch {
    return null;
  }
}

/* Conditions (b.2) + (c): review.baseCommit is an ancestor of current origin/main, and commit is a fast-forward from origin/main. */
async function verifiedMainLine(ctx: Reader, repo: Repo, candidateBaseSha: string, commit: string): Promise<string | null> {
  const mainSha = await verifiedFastForward(ctx, repo, commit);
  if (!mainSha) return null;
  return (await verifiedAncestorSha(ctx, repo, candidateBaseSha, mainSha)) ? mainSha : null;
}

async function enabledAnyMainRepo(ctx: Reader, task: Task): Promise<{ department: Dept; repo: Repo } | null> {
  if (!ctx.config) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]).catch(() => null);
  if (!found || !isMainRepository(found.department, found.repo)) return null;
  return (await isAutonomousReleaseEnabled(ctx.db, found.department.id)) ? { department: found.department, repo: found.repo } : null;
}

/* Only a result that goes to its own main line straight is approved here for echelon candidates: of a product, or a part of a
   department, that keeps a repository of its own. A top-level department releases echelon work through release_turn. */
async function enabledMainRepo(ctx: Reader, task: Task): Promise<{ department: Dept; repo: Repo } | null> {
  const found = await enabledAnyMainRepo(ctx, task);
  return found?.department.parentId ? found : null;
}

async function activeTurnkeyExecutor(db: QueryDb, task: Task): Promise<{ id: string; name: string } | null> {
  const executorId = task.executorAgentId ?? task.assigneeAgentId;
  if (!executorId || !(await turnkeyTeamOf(db, task.companyId, executorId))) return null;
  const [row] = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, executorId), eq(agents.companyId, task.companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return row ?? null;
}

async function verifiedTurnkeyTask(
  db: QueryDb,
  task: Task,
  repositoryOwnerId: string,
  baseCommitSha: string,
): Promise<{ task: Task; verdict: VerifiedVerdict } | null> {
  const placeIds = await repoDepartmentIds(db, task.companyId, repositoryOwnerId);
  if (!taskInRepoScope(task, placeIds)) return null;
  const route = await routeOf(db, task);
  if (route.state.resultKind !== 'turnkey' || route.state.phase !== 'active') return null;
  const executor = await activeTurnkeyExecutor(db, task);
  if (!executor) return null;
  return {
    task,
    verdict: {
      eventId: null,
      reviewerAgentId: executor.id,
      reviewerName: executor.name,
      stage: 'turnkey',
      baseCommitSha,
      allowedRunBranches: new Set<string>([`task-${task.number}`, 'main']),
      allowedTaskIds: new Set<string>([task.id]),
      isTurnkey: true,
    },
  };
}

async function smugglesOpenTurn(ctx: Reader, department: Dept, repo: Repo, companyId: string, baseCommitSha: string, commit: string): Promise<boolean> {
  if (department.parentId) return false;
  const openTurn = await openTurnOf(ctx.db, companyId, department.id);
  const turnHead = openTurn ? await headOf(ctx, repo, `turn-${openTurn.number}`) : null;
  if (!turnHead || turnHead === baseCommitSha) return false;
  return branchHolds(ctx, repo, commit, turnHead);
}

async function verifyTurnkeyConditions(ctx: Reader, task: Task, commit: string): Promise<VerifiedProof | null> {
  const found = await enabledAnyMainRepo(ctx, task);
  const baseCommitSha = found ? await verifiedFastForward(ctx, found.repo, commit) : null;
  if (!found || !baseCommitSha) return null;
  const tk = await verifiedTurnkeyTask(ctx.db, task, found.department.id, baseCommitSha);
  if (!tk || (await headOf(ctx, found.repo, `task-${tk.task.number}`)) !== commit) return null;
  if (await smugglesOpenTurn(ctx, found.department, found.repo, task.companyId, baseCommitSha, commit)) return null;
  const run = await verifiedFullRun(ctx, ctx.db, task.companyId, found.department, commit, true, tk.verdict.allowedRunBranches, tk.verdict.allowedTaskIds);
  return run ? { department: found.department, repo: found.repo, run, verdict: tk.verdict, baseCommitSha } : null;
}

async function verifyAllConditions(ctx: Reader, task: Task, commit: string): Promise<VerifiedProof | null> {
  const found = await enabledMainRepo(ctx, task);
  if (!found) return null;
  const verdict = await verifiedIndependentVerdict(ctx.db, task, found.department.id, commit);
  if (!verdict) return null;
  const baseCommitSha = await verifiedMainLine(ctx, found.repo, verdict.baseCommitSha, commit);
  if (!baseCommitSha) return null;
  const run = await verifiedFullRun(ctx, ctx.db, task.companyId, found.department, commit, true, verdict.allowedRunBranches);
  return run ? { department: found.department, repo: found.repo, run, verdict, baseCommitSha } : null;
}

/* Held so a switch of the department that holds the repository waits for the record. */
async function enabledMainInTransaction(tx: Tx, companyId: string, departmentId: string): Promise<boolean> {
  const [deptRow] = await tx.select({ repoBranch: departments.repoBranch, parentId: departments.parentId }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  if (!deptRow) return false;
  const [top] = await tx.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, deptRow.parentId ?? departmentId)).for('share');
  return Boolean(top?.on) && (deptRow.repoBranch ?? 'main') === 'main';
}

async function reverifyInTransaction(
  tx: Tx,
  task: Task,
  commit: string,
  department: Dept,
  baseCommitSha: string,
  isTurnkey = false,
): Promise<{ run: VerifiedRun; verdict: VerifiedVerdict } | null> {
  if (!(await enabledMainInTransaction(tx, task.companyId, department.id))) return null;
  const verdict = isTurnkey
    ? (await verifiedTurnkeyTask(tx, task, department.id, baseCommitSha))?.verdict ?? null
    : await verifiedIndependentVerdict(tx, task, department.id, commit);
  if (!verdict) return null;
  const run = await verifiedFullRun(null, tx, task.companyId, department, commit, false, verdict.allowedRunBranches, verdict.allowedTaskIds);
  return run ? { run, verdict } : null;
}

function journalValues(
  task: Task,
  agentId: string,
  agentName: string,
  commit: string,
  baseCommitSha: string,
  department: Dept,
  fresh: { run: VerifiedRun; verdict: VerifiedVerdict },
) {
  return {
    companyId: task.companyId,
    departmentId: task.departmentId ?? department.id,
    taskId: task.id,
    taskNumber: task.number,
    agentId,
    agentName,
    commitSha: commit,
    baseCommitSha,
    testRunId: fresh.run.id,
    testRunNumber: fresh.run.number,
    reviewerAgentId: fresh.verdict.reviewerAgentId,
    reviewerName: fresh.verdict.reviewerName,
    verdictEventId: fresh.verdict.eventId,
    verdictStage: fresh.verdict.stage,
  };
}

async function insertJournalRow(
  tx: Tx,
  task: Task,
  agentId: string,
  commit: string,
  proof: VerifiedProof,
): Promise<{ id: string; baseCommitSha: string } | null> {
  const fresh = await reverifyInTransaction(tx, task, commit, proof.department, proof.verdict.baseCommitSha, Boolean(proof.verdict.isTurnkey));
  if (!fresh || fresh.verdict.baseCommitSha !== proof.verdict.baseCommitSha) return null;
  const [requester] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, task.companyId)));
  if (!requester) return null;
  const [inserted] = await tx
    .insert(autonomousReleases)
    .values(journalValues(task, agentId, requester.name, commit, proof.baseCommitSha, proof.department, fresh))
    .returning({ id: autonomousReleases.id });
  return { id: inserted.id, baseCommitSha: proof.baseCommitSha };
}

function approvalProofWords(proof: VerifiedProof): string {
  return proof.verdict.isTurnkey
    ? `active turnkey executor ${proof.verdict.reviewerName}`
    : `independent ${proof.verdict.stage} PASS by ${proof.verdict.reviewerName}`;
}

async function replyForCoveredTurn(
  ctx: Ctx,
  task: Task,
  agentId: string,
  commit: string,
  reasonText: string,
  ready: NonNullable<Awaited<ReturnType<typeof autonomousTurnReleaseReady>>>,
): Promise<{ moved: Moved; text: string }> {
  const noteText =
    `Autonomous release is enabled and covers Turn ${ready.turnNumber} at ${commit} (full test run ${ready.runNumber}): ` +
    `record the release directly with release_turn. ${reasonText}`;
  const moved = await comment(ctx, { agentId }, task.id, noteText);
  return {
    moved,
    text:
      `No human card needed: autonomous release is enabled and covers Turn ${ready.turnNumber} at ${commit} ` +
      `(full test run ${ready.runNumber}). Record the release directly with release_turn (runId: ${ready.runId}).`,
  };
}

/* Auto-approves an exact commit before push without opening a human card when autonomous release is on and all proofs hold. */
export async function tryAutonomousCommitApproval(
  ctx: Ctx,
  task: Task,
  agentId: string,
  commit: string,
  reasonText: string,
): Promise<{ moved: Moved; text: string } | null> {
  const fresh = await loadTask(ctx.db, task.id);
  mayAsk(fresh, agentId);
  refusePaused(fresh);
  const turnReady = await autonomousTurnReleaseReady(ctx, fresh, agentId, commit);
  if (turnReady) return replyForCoveredTurn(ctx, fresh, agentId, commit, reasonText, turnReady);
  const proof = (await verifyAllConditions(ctx, fresh, commit)) ?? (await verifyTurnkeyConditions(ctx, fresh, commit));
  if (!proof) return null;
  const recorded = await ctx.db.transaction(tx => insertJournalRow(tx, fresh, agentId, commit, proof));
  if (!recorded) return null;
  const who = approvalProofWords(proof);
  const noteText =
    `Autonomous release approved exact commit ${commit} before push without a human card: ` +
    `test run ${proof.run.number} passed full suite on ${commit}, ${who}, fast-forward from ${proof.repo.branch} (${recorded.baseCommitSha}). ${reasonText}`;
  const moved = await comment(ctx, { agentId }, fresh.id, noteText);
  return {
    moved,
    text: `No human card needed: autonomous release approved exact commit ${commit} (full test run ${proof.run.number}, ${who}, fast-forward from ${proof.repo.branch} at ${recorded.baseCommitSha}).`,
  };
}

async function findRecordedAutoApproval(db: QueryDb, task: Task, commit: string): Promise<{ id: string; baseCommitSha: string } | null> {
  const [row] = await db
    .select({ id: autonomousReleases.id, baseCommitSha: autonomousReleases.baseCommitSha })
    .from(autonomousReleases)
    .where(and(eq(autonomousReleases.companyId, task.companyId), eq(autonomousReleases.taskId, task.id), eq(autonomousReleases.commitSha, commit)))
    .orderBy(desc(autonomousReleases.createdAt), desc(autonomousReleases.id))
    .limit(1);
  return row ?? null;
}

export async function hasRecordedAutoApproval(db: QueryDb, task: Task, commit: string): Promise<boolean> {
  return Boolean(await findRecordedAutoApproval(db, task, commit));
}

async function loadAcceptanceTarget(ctx: Reader, task: Task, commit: string, allowTopLevel = false) {
  const found = allowTopLevel ? await enabledAnyMainRepo(ctx, task) : await enabledMainRepo(ctx, task);
  if (!found) return null;
  const recorded = await findRecordedAutoApproval(ctx.db, task, commit);
  return recorded ? { recorded, department: found.department, repo: found.repo } : null;
}

async function verifiedRecordedLine(ctx: Reader, repo: Repo, candidateBaseSha: string, recordedMainSha: string, commit: string): Promise<boolean> {
  const [baseOnMain, ffFromRecorded] = await Promise.all([
    verifiedAncestorSha(ctx, repo, candidateBaseSha, recordedMainSha),
    verifiedAncestorSha(ctx, repo, recordedMainSha, commit),
  ]);
  return baseOnMain && ffFromRecorded;
}

async function verifyTurnkeyMainAcceptance(ctx: Reader, task: Task, commit: string): Promise<RecordedMainApproval | null> {
  const target = await loadAcceptanceTarget(ctx, task, commit, true);
  if (!target) return null;
  const tk = await verifiedTurnkeyTask(ctx.db, task, target.department.id, target.recorded.baseCommitSha);
  if (!tk || (await headOf(ctx, target.repo, `task-${tk.task.number}`)) !== commit) return null;
  if (!(await verifiedAncestorSha(ctx, target.repo, target.recorded.baseCommitSha, commit))) return null;
  if (await smugglesOpenTurn(ctx, target.department, target.repo, task.companyId, target.recorded.baseCommitSha, commit)) return null;
  const run = await verifiedFullRun(ctx, ctx.db, task.companyId, target.department, commit, true, tk.verdict.allowedRunBranches, tk.verdict.allowedTaskIds);
  return run
    ? {
        entryId: target.recorded.id,
        baseCommitSha: target.recorded.baseCommitSha,
        candidateBaseCommitSha: target.recorded.baseCommitSha,
        department: target.department,
        isTurnkey: true,
      }
    : null;
}

/* Verifies pre-push autonomous release journal row + live run, verdict/turnkey executor and recorded base ancestry for main acceptance. */
export async function verifyAutonomousMainAcceptance(ctx: Reader, task: Task, commit: string): Promise<RecordedMainApproval | null> {
  const target = await loadAcceptanceTarget(ctx, task, commit);
  const verdict = target ? await verifiedIndependentVerdict(ctx.db, task, target.department.id, commit) : null;
  if (target && verdict && (await verifiedRecordedLine(ctx, target.repo, verdict.baseCommitSha, target.recorded.baseCommitSha, commit))) {
    const run = await verifiedFullRun(ctx, ctx.db, task.companyId, target.department, commit, true, verdict.allowedRunBranches);
    if (run) {
      return {
        entryId: target.recorded.id,
        baseCommitSha: target.recorded.baseCommitSha,
        candidateBaseCommitSha: verdict.baseCommitSha,
        department: target.department,
      };
    }
  }
  return verifyTurnkeyMainAcceptance(ctx, task, commit);
}

export async function confirmAutonomousMainAcceptance(
  tx: Tx,
  task: Task,
  commit: string,
  proof: RecordedMainApproval,
): Promise<string | null> {
  const [existing] = await tx
    .select({ id: autonomousReleases.id })
    .from(autonomousReleases)
    .where(
      and(
        eq(autonomousReleases.id, proof.entryId),
        eq(autonomousReleases.companyId, task.companyId),
        eq(autonomousReleases.taskId, task.id),
        eq(autonomousReleases.commitSha, commit),
        eq(autonomousReleases.baseCommitSha, proof.baseCommitSha),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const fresh = await reverifyInTransaction(tx, task, commit, proof.department, proof.candidateBaseCommitSha, Boolean(proof.isTurnkey));
  return fresh && fresh.verdict.baseCommitSha === proof.candidateBaseCommitSha ? existing.id : null;
}
