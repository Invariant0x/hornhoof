import { EnvironmentSnapshot, validateEnvironmentDescription } from '@hornhoof/protocol';
import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { agents, autonomousReleases, departments, people, taskEvents, tasks, testParts, testRuns } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { repoAt } from '../departments/repository.js';
import { evidenceOf } from '../testruns/evidence.js';
import { coversEveryPart } from '../testruns/github-status.js';
import { scopeKey } from '../testruns/load.js';
import { runScope, scopeSource } from '../testruns/purpose.js';
import { keptEverything, ofItsRelease } from '../testruns/reuse.js';
import { passedProductPart } from '../testruns/receipts.js';
import { currentCandidate } from './echelons-candidates.js';
import { routeOf, type Route } from './echelons-store.js';
import { comment, loadTask, mayAsk, type Moved, type Task, type Tx } from './engine.js';
import { refusePaused } from './pause.js';
import { exactComparison } from './review-context.js';

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
  eventId: number;
  reviewerAgentId: string;
  reviewerName: string;
  stage: string;
  baseCommitSha: string;
};
type VerifiedProof = { department: Dept; repo: Repo; run: VerifiedRun; verdict: VerifiedVerdict; baseCommitSha: string };
type VerdictRow = { id: number; agentId: string | null; pass: boolean; wrongGoal: boolean; stage: string; reviewedCommit: string };

export type RecordedMainApproval = { entryId: string; baseCommitSha: string; candidateBaseCommitSha: string; department: Dept };

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

/* Who turns a department's autonomous release on or off: a signed-in person who runs that department, or the orchestrator
   acting for the CEO, who runs every department; never a head or an assistant acting for one. */
export async function maySetAutonomousRelease(db: Pick<Db, 'select'>, me: Person, departmentId: string): Promise<boolean> {
  if (me.status !== 'active' || Boolean(me.viaHead) || Boolean(me.assistant)) return false;
  const [row] = await db
    .select(idOnly(people))
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
  const [row] = await db.select(idOnly(autonomousReleases)).from(autonomousReleases).where(scope).limit(1);
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
  return (run.parts > 0 || keptEverything(run)) && parts.length === run.parts && parts.every((part, i) => validPartAt(part, i, companyId, commit));
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

/* Every suite of the release's profile ran, in full or taking only what its release proved. */
function checksWholeRelease(run: Run, snapshot: Snapshot): boolean {
  const scope = runScope(scopeSource(snapshot), undefined, 0), fullRun = snapshot.description.manifest.execution?.fullRun;
  if (scope.leftOut.length || !snapshot.description.manifest.suites.length) return false;
  return !fullRun || (scope.profile === fullRun.profile && ofItsRelease(run.fileCache));
}

async function validFullProductRun(run: Run, parts: Part[], companyId: string, departmentId: string, commit: string): Promise<boolean> {
  const snapshot = matchingSnapshot(run, companyId, departmentId, commit);
  if (!snapshot || !checksWholeRelease(run, snapshot)) return false;
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

/* A shared run checks a release: of main, or of a release-X.Y.Z branch before main moves. */
function isReleaseRunBranch(branch: string | null): boolean {
  return branch === 'main' || Boolean(branch && RELEASE_BRANCH_RE.test(branch));
}

function isPassedCommitRun(run: Run, commit: string): boolean {
  return run.status === 'passed' && Boolean(run.finishedAt) && run.commitSha === commit && isReleaseRunBranch(run.branch);
}

function matchesLegacyFullCommand(department: Dept, command: string): boolean {
  return command === department.repoFullTestCommand && coversEveryPart(command);
}

async function isWholeSuiteGreenRun(db: QueryDb, companyId: string, department: Dept, commit: string, run: Run): Promise<boolean> {
  if (!isPassedCommitRun(run, commit)) return false;
  const parts = await db.select().from(testParts).where(eq(testParts.runId, run.id)).orderBy(asc(testParts.part));
  if (!completeRunParts(parts, run, companyId, commit)) return false;
  return run.command === '' ? validFullProductRun(run, parts, companyId, department.id, commit) : matchesLegacyFullCommand(department, run.command);
}

async function newestFailedNumber(db: QueryDb, companyId: string, departmentId: string, commit: string): Promise<number> {
  const [failed] = await db
    .select(only(testRuns, 'number'))
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

/* Condition (a): a completed green whole run of a release, on main or a release-X.Y.Z branch, at that exact 40-char SHA with proves: true. */
async function verifiedFullRun(
  ctx: FreshnessReader,
  db: QueryDb,
  companyId: string,
  department: Dept,
  commit: string,
  checkFreshness: boolean,
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
    if ((await isWholeSuiteGreenRun(db, companyId, department, commit, run)) && (await isCurrentRunEvidence(ctx, run, checkFreshness))) {
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
): Promise<EchelonCandidate | null> {
  const candidate = await loadCurrentCommitCandidate(db, verdictTask, route, commit);
  return candidate && candidateBranchLeadsToMain(verdictTask.number, candidate.branch) ? candidate : null;
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
    const [row] = await db.select(only(tasks, 'parentId')).from(tasks).where(and(eq(tasks.id, parentId), eq(tasks.companyId, task.companyId)));
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
    .select(only(agents, 'name'))
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
): Promise<VerifiedVerdict | null> {
  const authors = await commitAuthors(db, verdictTask, askingTask);
  if (!(await securityStageVerified(db, askingTask.companyId, route.state.security.required, latestByStage.get('security'), authors))) return null;
  const primary = primaryStageRow(latestByStage);
  if (!primary) return null;
  const reviewer = await activeReviewer(db, askingTask.companyId, primary.agentId, authors);
  return reviewer ? { eventId: primary.id, stage: primary.stage, ...reviewer, baseCommitSha } : null;
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
  const rows = await queryCandidateVerdicts(db, verdictTask.companyId, verdictTask.id, eligible.id);
  const latestByStage = allLatestStagesPassed(rows, commit);
  if (!latestByStage) return null;
  return verifiedPrimaryVerdict(db, verdictTask, askingTask, route, latestByStage, eligible.baseCommit);
}

async function candidateTaskIdsOnCommit(db: QueryDb, companyId: string, placeIds: string[], commit: string): Promise<string[]> {
  const rows = await db
    .select(only(taskEvents, 'taskId'))
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

/* Only a result that goes to its own main line straight is approved here: of a product, or a part of a department, that keeps
   a repository of its own. A top-level department releases turns: its results join the open turn, and main moves for it
   only by the release of that turn, which autonomous release approves at release_turn. */
async function enabledMainRepo(ctx: Reader, task: Task): Promise<{ department: Dept; repo: Repo } | null> {
  if (!ctx.config) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]).catch(() => null);
  if (!found || !found.department.parentId || !isMainRepository(found.department, found.repo)) return null;
  return (await isAutonomousReleaseEnabled(ctx.db, found.department.id)) ? { department: found.department, repo: found.repo } : null;
}

async function verifyAllConditions(ctx: Reader, task: Task, commit: string): Promise<VerifiedProof | null> {
  const found = await enabledMainRepo(ctx, task);
  if (!found) return null;
  const verdict = await verifiedIndependentVerdict(ctx.db, task, found.department.id, commit);
  if (!verdict) return null;
  const baseCommitSha = await verifiedMainLine(ctx, found.repo, verdict.baseCommitSha, commit);
  if (!baseCommitSha) return null;
  const run = await verifiedFullRun(ctx, ctx.db, task.companyId, found.department, commit, true);
  return run ? { department: found.department, repo: found.repo, run, verdict, baseCommitSha } : null;
}

/* Held so a switch of the department that holds the repository waits for the record. */
async function enabledMainInTransaction(tx: Tx, companyId: string, departmentId: string): Promise<boolean> {
  const [deptRow] = await tx.select({ repoBranch: departments.repoBranch, parentId: departments.parentId }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  if (!deptRow) return false;
  const [top] = await tx.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, deptRow.parentId ?? departmentId)).for('share');
  return Boolean(top?.on) && (deptRow.repoBranch ?? 'main') === 'main';
}

async function reverifyInTransaction(tx: Tx, task: Task, commit: string, department: Dept): Promise<{ run: VerifiedRun; verdict: VerifiedVerdict } | null> {
  if (!(await enabledMainInTransaction(tx, task.companyId, department.id))) return null;
  const verdict = await verifiedIndependentVerdict(tx, task, department.id, commit);
  if (!verdict) return null;
  const run = await verifiedFullRun(null, tx, task.companyId, department, commit, false);
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
  const fresh = await reverifyInTransaction(tx, task, commit, proof.department);
  if (!fresh || fresh.verdict.baseCommitSha !== proof.verdict.baseCommitSha) return null;
  const [requester] = await tx.select(only(agents, 'name')).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, task.companyId)));
  if (!requester) return null;
  const [inserted] = await tx
    .insert(autonomousReleases)
    .values(journalValues(task, agentId, requester.name, commit, proof.baseCommitSha, proof.department, fresh))
    .returning({ id: autonomousReleases.id });
  return { id: inserted.id, baseCommitSha: proof.baseCommitSha };
}

/* Auto-approves an exact commit before push without opening a human card when autonomous release is on and (a)+(b)+(c) hold. */
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
  const proof = await verifyAllConditions(ctx, fresh, commit);
  if (!proof) return null;
  const recorded = await ctx.db.transaction(tx => insertJournalRow(tx, fresh, agentId, commit, proof));
  if (!recorded) return null;
  const noteText =
    `Autonomous release approved exact commit ${commit} before push without a human card: ` +
    `test run ${proof.run.number} passed full suite on ${commit}, ` +
    `independent ${proof.verdict.stage} PASS by ${proof.verdict.reviewerName}, fast-forward from ${proof.repo.branch} (${recorded.baseCommitSha}). ${reasonText}`;
  const moved = await comment(ctx, { agentId }, fresh.id, noteText);
  return {
    moved,
    text:
      `No human card needed: autonomous release approved exact commit ${commit} ` +
      `(full test run ${proof.run.number}, independent ${proof.verdict.stage} PASS by ${proof.verdict.reviewerName}, fast-forward from ${proof.repo.branch} at ${recorded.baseCommitSha}).`,
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

async function loadAcceptanceTarget(ctx: Reader, task: Task, commit: string) {
  const found = await enabledMainRepo(ctx, task);
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

/* Verifies pre-push autonomous release journal row + live run, verdict and recorded base ancestry for main acceptance. */
export async function verifyAutonomousMainAcceptance(ctx: Reader, task: Task, commit: string): Promise<RecordedMainApproval | null> {
  const target = await loadAcceptanceTarget(ctx, task, commit);
  if (!target) return null;
  const verdict = await verifiedIndependentVerdict(ctx.db, task, target.department.id, commit);
  if (!verdict || !(await verifiedRecordedLine(ctx, target.repo, verdict.baseCommitSha, target.recorded.baseCommitSha, commit))) return null;
  const run = await verifiedFullRun(ctx, ctx.db, task.companyId, target.department, commit, true);
  return run
    ? {
        entryId: target.recorded.id,
        baseCommitSha: target.recorded.baseCommitSha,
        candidateBaseCommitSha: verdict.baseCommitSha,
        department: target.department,
      }
    : null;
}

export async function confirmAutonomousMainAcceptance(
  tx: Tx,
  task: Task,
  commit: string,
  proof: RecordedMainApproval,
): Promise<string | null> {
  const [existing] = await tx
    .select(idOnly(autonomousReleases))
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
  const fresh = await reverifyInTransaction(tx, task, commit, proof.department);
  return fresh && fresh.verdict.baseCommitSha === proof.candidateBaseCommitSha ? existing.id : null;
}
