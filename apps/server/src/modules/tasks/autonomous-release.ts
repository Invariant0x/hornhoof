import type { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, autonomousReleases, departments, taskEvents, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ciAddress, repoAt } from '../departments/repository.js';
import { currentCandidate } from './echelons-candidates.js';
import { routeOf, type Route } from './route-records.js';
import { comment } from './comments.js';
import { loadTask, mayAsk, type Moved, type Task, type Tx } from './state.js';
import { refusePaused } from './pause.js';
import { ciResult, ciWords, readCiOf, type CiResult } from './release-ci.js';
import { heldLineage } from '../testruns/compare.js';
import type { RepoAddress } from '../testruns/refs.js';

const RELEASE_BRANCH_RE = /^release-\d+\.\d+\.\d+$/;

type QueryDb = Db | Tx;
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare' | 'readCi'>>;
type Dept = typeof departments.$inferSelect;
type Repo = NonNullable<Awaited<ReturnType<typeof repoAt>>>['repo'];
type VerifiedVerdict = {
  eventId: number;
  reviewerAgentId: string;
  reviewerName: string;
  stage: string;
  baseCommitSha: string;
};
type VerifiedProof = { department: Dept; repo: Repo; ci: CiResult; verdict: VerifiedVerdict; baseCommitSha: string };
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
  testRunNumber: number | null;
  ciState: string | null;
  ciChecks: number | null;
  reviewerAgentId: string | null;
  reviewerName: string;
  verdictStage: string;
  createdAt: string;
};

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
    ciState: row.ciState,
    ciChecks: row.ciChecks,
    reviewerAgentId: row.reviewerAgentId,
    reviewerName: row.reviewerName,
    verdictStage: row.verdictStage,
    createdAt: row.createdAt.toISOString(),
  }));
}

function isMainRepository(department: Dept, repo?: Repo): boolean {
  return (department.repoBranch ?? 'main') === 'main' && (!repo || repo.branch === 'main');
}

/* Condition (a): the repository's CI is green on that exact commit, or the repository has none. The host says it as the approval
   is asked: no word of the caller counts, and a host that cannot be read now, or CI that is red, under way or ran nothing that
   succeeded, lets nothing go. */
async function verifiedCi(ctx: Reader, repo: RepoAddress, commit: string): Promise<CiResult | null> {
  return ciResult(await readCiOf(ctx, repo, commit));
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
    return !!heldLineage(await ctx.readCompare(repo, { base, head }, 10_000), base, head);
  } catch {
    return false;
  }
}

/* Condition (c): the commit is a fast-forward from current origin/main (ahead or identical, never diverged or behind). */
async function verifiedFastForward(ctx: Reader, repo: Repo, commit: string): Promise<string | null> {
  if (repo.branch !== 'main' || !ctx.readCommit) return null;
  try {
    const mainHead = await ctx.readCommit(repo, { branch: 'main' }, 5_000);
    if ('problem' in mainHead || mainHead.tag) return null;
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
  const ci = await verifiedCi(ctx, ciAddress(found), commit);
  return ci ? { department: found.department, repo: found.repo, ci, verdict, baseCommitSha } : null;
}

/* Held so a switch of the department that holds the repository waits for the record. */
async function enabledMainInTransaction(tx: Tx, companyId: string, departmentId: string): Promise<boolean> {
  const [deptRow] = await tx.select({ repoBranch: departments.repoBranch, parentId: departments.parentId }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  if (!deptRow) return false;
  const [top] = await tx.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, deptRow.parentId ?? departmentId)).for('share');
  return Boolean(top?.on) && (deptRow.repoBranch ?? 'main') === 'main';
}

/* What the transaction holds still stands: the department's switch and the verdict. The host's CI answer was read before it and is
   not asked again inside it. */
async function reverifyInTransaction(tx: Tx, task: Task, commit: string, department: Dept): Promise<{ verdict: VerifiedVerdict } | null> {
  if (!(await enabledMainInTransaction(tx, task.companyId, department.id))) return null;
  const verdict = await verifiedIndependentVerdict(tx, task, department.id, commit);
  if (!verdict) return null;
  return { verdict };
}

function journalValues(
  task: Task,
  agentId: string,
  agentName: string,
  commit: string,
  baseCommitSha: string,
  department: Dept,
  ci: CiResult,
  fresh: { verdict: VerifiedVerdict },
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
    ciState: ci.state,
    ciChecks: ci.state === 'green' ? ci.checks : null,
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
    .values(journalValues(task, agentId, requester.name, commit, proof.baseCommitSha, proof.department, proof.ci, fresh))
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
    `${ciWords(proof.ci)}, independent ${proof.verdict.stage} PASS by ${proof.verdict.reviewerName}, fast-forward from ${proof.repo.branch} (${recorded.baseCommitSha}). ${reasonText}`;
  const moved = await comment(ctx, { agentId }, fresh.id, noteText);
  return {
    moved,
    text:
      `No human card needed: autonomous release approved exact commit ${commit} ` +
      `(${ciWords(proof.ci)}, independent ${proof.verdict.stage} PASS by ${proof.verdict.reviewerName}, fast-forward from ${proof.repo.branch} at ${recorded.baseCommitSha}).`,
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

/* Verifies pre-push autonomous release journal row + the repository's CI now, verdict and recorded base ancestry for main acceptance. */
export async function verifyAutonomousMainAcceptance(ctx: Reader, task: Task, commit: string): Promise<RecordedMainApproval | null> {
  const target = await loadAcceptanceTarget(ctx, task, commit);
  if (!target) return null;
  const verdict = await verifiedIndependentVerdict(ctx.db, task, target.department.id, commit);
  if (!verdict || !(await verifiedRecordedLine(ctx, target.repo, verdict.baseCommitSha, target.recorded.baseCommitSha, commit))) return null;
  const ci = await verifiedCi(ctx, ciAddress(target), commit);
  return ci
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
