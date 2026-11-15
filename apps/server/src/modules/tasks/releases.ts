import { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, autonomousReleases, companies, departments, people, requests, taskEvents, taskRoutes, tasks, testParts, testRuns, turnReleases, turns, type ReleasedTask } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { note, refuse, type Task, type Tx } from './engine.js';
import { taskByRef } from './views.js';
import { keepSnapshot } from './pipeline-report.js';
import { recordTurnSummary } from './wait-goals.js';
import { lastTurnNumber } from './numbers.js';
import { recordWaitNotice } from './wait-notices.js';
import { openTurnOf } from './turn-department.js';
import { branchHolds, ensureTurnBranch, headOf, integrationTarget, type IntegrationTarget } from './turn-integration.js';
import { turnkeyTeamOf } from './turnkey.js';

/* A turn is a release of its department. Its holder records the release before main moves: the exact commit R, the head of
   turn-<number>, main under it, the full run on R, the results R brings with the verdicts on them, and what approved R: a
   person's approval of it, or, with autonomous release on, the entry of the autonomous release log, for a release every
   commit of which was checked. Main then goes to R by fast-forward and R is tagged vX.Y.Z; the minute round closes the turn
   on that tag, and what the release left out goes into the next turn, whose branch starts from the head of this one. */

type Turn = typeof turns.$inferSelect;
type Release = typeof turnReleases.$inferSelect;
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare' | 'readTags' | 'readBranches' | 'createBranch' | 'log'>>;
type Repo = IntegrationTarget['repo'];

const lockCompany = (tx: Tx, companyId: string) => tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for('no key update');

/* A version tag: vX.Y.Z, compared by its numbers. */
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;
function versionOf(name: string): [number, number, number] | null {
  const found = VERSION.exec(name);
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}
export function newerVersion(a: string, b: string): boolean {
  const x = versionOf(a), y = versionOf(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/* The real full run of R: of the turn branch at R, every part passed, nothing reused, and no newer run of R failed since. */
async function requireFullRun(db: Ctx['db'] | Tx, turn: Turn, branch: string, departmentId: string, runId: string, commit: string): Promise<void> {
  const notFull = (why: string) => refuse(409, 'task_invalid', `Run ${runId} is no full run of ${commit} on ${branch}: ${why}. A release needs a real full run on its exact commit: every test, nothing reused.`);
  const [run] = await db.select().from(testRuns).where(and(eq(testRuns.id, runId), eq(testRuns.companyId, turn.companyId)));
  if (!run) throw notFull('there is no such run');
  if (run.departmentId !== departmentId || run.branch !== branch || run.commitSha !== commit) throw notFull(`it ran ${run.branch ?? 'no branch'} at ${run.commitSha ?? 'no commit'}`);
  if (run.status !== 'passed') throw notFull(`it ${run.status === 'running' ? 'is still running' : run.status}`);
  if (run.fileCache && (run.fileCache.mode !== 'full' || run.fileCache.reused > 0)) throw notFull(`it reused ${run.fileCache.reused} green results`);
  const parts = await db.select({ status: testParts.status }).from(testParts).where(eq(testParts.runId, run.id));
  if (!parts.length || parts.length !== run.parts || parts.some(part => part.status !== 'passed')) throw notFull('not every part of it passed');
  const [newer] = await db.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.companyId, turn.companyId), eq(testRuns.commitSha, commit), eq(testRuns.status, 'failed'), gt(testRuns.createdAt, run.createdAt))).limit(1);
  if (newer) throw notFull(`a newer run of the same commit failed, ${newer.id}`);
}

/* A person's approval of exactly R, on the release task, or none. */
async function personApproval(db: Ctx['db'] | Tx, task: Task, commit: string): Promise<string | null> {
  const [approval] = await db.select({ id: requests.id }).from(requests).where(and(eq(requests.companyId, task.companyId), eq(requests.taskId, task.id), eq(requests.kind, 'approval'),
    eq(requests.status, 'approved'), eq(requests.commit, commit), isNotNull(requests.answeredBy), isNotNull(requests.answeredAt))).orderBy(desc(requests.answeredAt)).limit(1);
  return approval?.id ?? null;
}

const needsPerson = (task: Task, commit: string, why: string) =>
  refuse(403, 'decision_not_allowed', `A release needs a person's approval of exactly ${commit}: ask for it on #${task.number} with ask_person, kind approval, naming the commit.${why}`);

/* The department has autonomous release on, held so a switch of its people waits for the record, for a repository whose main
   line is main. */
async function autonomousOn(db: Ctx['db'] | Tx, departmentId: string, repo: Repo, hold = false): Promise<boolean> {
  const query = db.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, departmentId));
  const [department] = hold ? await query.for('share') : await query;
  return !!department?.on && repo.branch === 'main';
}

type Approver = { id: string; name: string; stage: string };

async function liveVerdictCheckers(db: Ctx['db'] | Tx, nonTurnkey: ReleasedTask[]): Promise<Approver[] | null> {
  if (!nonTurnkey.length) return [];
  const ids = nonTurnkey.flatMap(r => r.verdicts).map(Number).filter(Number.isSafeInteger);
  if (nonTurnkey.some(r => !r.verdicts.length) || !ids.length) return null;
  const rows = await db.select({ id: taskEvents.id, agentId: agents.id, name: agents.name, removedAt: agents.removedAt, switchedOffAt: agents.switchedOffAt, stage: sql<string>`coalesce(${taskEvents.data}->>'stage', 'review')` })
    .from(taskEvents).innerJoin(agents, eq(agents.id, taskEvents.agentId)).where(and(inArray(taskEvents.id, ids), eq(taskEvents.kind, 'verdict'))).orderBy(asc(taskEvents.id));
  if (rows.length !== new Set(ids).size || rows.some(row => row.removedAt || row.switchedOffAt)) return null;
  return rows.map(row => ({ id: row.agentId, name: row.name, stage: row.stage }));
}

async function liveTurnkeyAgents(db: Ctx['db'] | Tx, companyId: string, turnkeyIds: string[], releaseHolderId: string | null): Promise<Approver[] | null> {
  if (releaseHolderId && !(await turnkeyTeamOf(db, companyId, releaseHolderId))) return null;
  const allIds = [...turnkeyIds, ...(releaseHolderId ? [releaseHolderId] : [])];
  if (!allIds.length) return [];
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, allIds), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (rows.length !== new Set(allIds).size) return null;
  const byId = new Map(rows.map(row => [row.id, row.name]));
  return allIds.map(id => ({ id, name: byId.get(id)!, stage: 'turnkey' }));
}

/* Who passed the results of a release, by their verdicts or active turnkey ownership on the exact commits: each still at work, or null. */
async function liveCheckers(db: Ctx['db'] | Tx, companyId: string, released: ReleasedTask[], releaseHolderId: string | null = null): Promise<Approver[] | null> {
  const verdicts = await liveVerdictCheckers(db, released.filter(r => !r.turnkeyAgentId));
  const turnkey = verdicts ? await liveTurnkeyAgents(db, companyId, released.flatMap(r => (r.turnkeyAgentId ? [r.turnkeyAgentId] : [])), releaseHolderId) : null;
  if (!verdicts || !turnkey) return null;
  const all = [...verdicts, ...turnkey];
  return all.length ? all : null;
}

/* The entry of the autonomous release log that approves R: the release task, its holder, R and main under it, the full run, and
   the checkers and turnkey executors that passed what R brings. */
async function logAutonomous(tx: Tx, turn: Turn, task: Task, agentId: string, commit: string, base: string, runId: string, released: ReleasedTask[], releaseHolderId: string | null): Promise<string | null> {
  const checkers = await liveCheckers(tx, turn.companyId, released, releaseHolderId);
  const [run] = await tx.select({ number: testRuns.number }).from(testRuns).where(eq(testRuns.id, runId));
  const [holder] = await tx.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
  if (!checkers || !run || !holder) return null;
  const unique = <T,>(items: T[]) => [...new Set(items)];
  const ids = unique(checkers.map(c => c.id));
  const [entry] = await tx.insert(autonomousReleases).values({
    companyId: turn.companyId, departmentId: turn.departmentId, taskId: task.id, taskNumber: task.number, agentId, agentName: holder.name, commitSha: commit, baseCommitSha: base,
    testRunId: runId, testRunNumber: run.number, reviewerAgentId: ids.length === 1 ? ids[0]! : null, reviewerName: unique(checkers.map(c => c.name)).join(', '), verdictStage: unique(checkers.map(c => c.stage)).join(', '),
  }).returning({ id: autonomousReleases.id });
  return entry!.id;
}

/* The commits of a comparison, or null where they could not all be read. */
async function commitsBetween(ctx: Reader, repo: Repo, base: string, head: string) {
  try {
    const compared = await ctx.readCompare?.(repo, { base, head }, 10_000);
    return compared?.complete && compared.baseSha === base && compared.headSha === head && compared.commits ? compared.commits : null;
  } catch {
    return null;
  }
}

type Accepted = {
  task: Task;
  commit: string;
  candidate: EchelonCandidate | null;
  verdicts: string[];
  checkersLive: boolean;
  turnkey: boolean;
  turnkeyAgentId: string | null;
  turnkeyLive: boolean;
};

async function isLiveAgentId(db: Ctx['db'], agentId: string | null): Promise<boolean> {
  if (!agentId) return false;
  const [live] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return Boolean(live);
}

async function acceptedTurnkeyResult(db: Ctx['db'], task: Task, report: { agentId: string | null; data: Record<string, unknown> } | undefined): Promise<Accepted> {
  const integration = report?.data.integration as { commit?: string } | undefined;
  const turnkeyAgentId = report?.agentId ?? task.executorAgentId ?? null;
  const turnkeyLive = await isLiveAgentId(db, turnkeyAgentId);
  return { task, commit: integration?.commit ?? '', candidate: null, verdicts: [], checkersLive: false, turnkey: true, turnkeyAgentId, turnkeyLive };
}

async function liveStageCheckers(db: Ctx['db'], candidate: EchelonCandidate | null, route: typeof taskRoutes.$inferSelect | undefined): Promise<boolean> {
  const stages = (route?.state.stages ?? []).filter(step => (step.stage === 'review' || step.stage === 'security') && step.status === 'complete');
  if (!candidate || !stages.length) return false;
  const owners = stages.flatMap(step => (step.ownerAgentId ? [step.ownerAgentId] : []));
  if (owners.some(id => id === candidate.producedBy.agentId)) return false;
  const live = await db.select({ id: agents.id }).from(agents).where(and(inArray(agents.id, owners), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return live.length === new Set(owners).size;
}

function reportedCommitOf(report: { data: Record<string, unknown> } | undefined): { candidateId: string | null; commit: string } {
  const accepted = report?.data.acceptedCandidate as { candidateId?: string; commit?: string } | undefined;
  const integration = report?.data.integration as { commit?: string } | undefined;
  return { candidateId: accepted?.candidateId ?? null, commit: accepted?.commit ?? integration?.commit ?? '' };
}

async function acceptedCandidateResult(
  db: Ctx['db'],
  task: Task,
  route: typeof taskRoutes.$inferSelect | undefined,
  report: { agentId: string | null; data: Record<string, unknown> } | undefined,
): Promise<Accepted> {
  const { candidateId, commit } = reportedCommitOf(report);
  const candidate = candidateId ? await candidateOf(db, task, candidateId) : null;
  const verdicts = candidate ? await passingVerdicts(db, task, candidate) : [];
  const checkersLive = await liveStageCheckers(db, candidate, route);
  return { task, commit, candidate, verdicts, checkersLive, turnkey: false, turnkeyAgentId: null, turnkeyLive: false };
}

/* What each result of the turn was accepted as, and the passing verdicts or active turnkey executor on that exact commit. */
async function acceptedResults(db: Ctx['db'], turn: Turn): Promise<Accepted[]> {
  const rows = await db.select().from(tasks).where(and(eq(tasks.companyId, turn.companyId), eq(tasks.turnId, turn.id))).orderBy(asc(tasks.number));
  const out: Accepted[] = [];
  for (const task of rows) {
    const [report] = await db.select({ agentId: taskEvents.agentId, data: taskEvents.data }).from(taskEvents)
      .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'), sql`(${taskEvents.data} ? 'acceptedCandidate' OR ${taskEvents.data} ? 'integration')`))
      .orderBy(desc(taskEvents.id)).limit(1);
    const [route] = await db.select().from(taskRoutes).where(eq(taskRoutes.taskId, task.id));
    out.push(route?.state.resultKind === 'turnkey' ? await acceptedTurnkeyResult(db, task, report) : await acceptedCandidateResult(db, task, route, report));
  }
  return out;
}

async function candidateOf(db: Ctx['db'], task: Task, candidateId: string): Promise<EchelonCandidate | null> {
  const handed = await db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->'candidate'->>'id' = ${candidateId}`)).limit(1);
  const parsed = EchelonCandidate.safeParse(handed[0]?.data.candidate);
  return parsed.success ? parsed.data : null;
}

async function passingVerdicts(db: Ctx['db'], task: Task, candidate: EchelonCandidate): Promise<string[]> {
  const rows = await db.select({ id: taskEvents.id }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'),
    sql`(${taskEvents.data}->>'pass')::boolean`, sql`${taskEvents.data}->>'reviewedCommit' = ${candidate.commit}`)).orderBy(asc(taskEvents.id));
  return rows.map(row => String(row.id));
}

async function turnkeyCommits(ctx: Reader, repo: Repo, turn: Turn, base: string, head: string) {
  const direct = await commitsBetween(ctx, repo, base, head);
  if (direct) return direct;
  const start = turn.baseCommit ?? turn.startCommit;
  if (!start || start === base || !(await branchHolds(ctx, repo, base, start))) return null;
  return commitsBetween(ctx, repo, start, head);
}

async function activeTurnkeyReleaseHolder(ctx: Reader, repo: Repo, releaseTask: Task, agentId: string, commit: string): Promise<boolean> {
  const [route] = await ctx.db.select().from(taskRoutes).where(eq(taskRoutes.taskId, releaseTask.id));
  if (route?.state.resultKind !== 'turnkey' || !(await turnkeyTeamOf(ctx.db, releaseTask.companyId, agentId))) return false;
  const [live] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return Boolean(live) && (await headOf(ctx, repo, `task-${releaseTask.number}`)) === commit;
}

async function turnkeyResultCoverage(ctx: Reader, repo: Repo, turn: Turn, base: string, result: Accepted, checked: Set<string>): Promise<string | null> {
  if (!result.commit || !result.turnkeyLive) return `#${result.task.number}: the turnkey executor of ${result.commit || 'its result'} is off or removed.`;
  const own = await turnkeyCommits(ctx, repo, turn, base, result.commit);
  if (!own) return `The commits of #${result.task.number} could not all be read.`;
  for (const c of own) checked.add(c.sha);
  return null;
}

async function candidateResultCoverage(ctx: Reader, repo: Repo, result: Accepted, checked: Set<string>): Promise<string | null> {
  if (!result.candidate) return `#${result.task.number} has no checked candidate.`;
  const flaw = !result.verdicts.length || !result.checkersLive
    ? `#${result.task.number}: a checker of ${result.candidate.commit} is off, removed or its author, or passed no verdict on it.`
    : null;
  const own = await commitsBetween(ctx, repo, result.candidate.baseCommit, result.candidate.commit);
  if (!own) return flaw ? `${flaw} The commits of #${result.task.number} could not all be read.` : `The commits of #${result.task.number} could not all be read.`;
  for (const c of own) checked.add(c.sha);
  return flaw;
}

function extraneousCommitNotes(extra: Array<{ sha: string; parents: string[] }>): string[] {
  return extra.map(c => (c.parents.length > 1 ? `${c.sha} is a merge made outside every checked candidate.` : `${c.sha} came in with no accepted candidate.`));
}

/* Whether every commit R brings over main is of a checked candidate or active turnkey result of the turn (plus an active turnkey
   release task whose task-<number> branch stands at R): anything unread, extraneous, or with an inactive checker or turnkey
   executor is uncovered. Only a covered release may be approved by itself. */
async function coverage(
  ctx: Reader,
  repo: Repo,
  turn: Turn,
  releaseTask: Task,
  agentId: string,
  base: string,
  commit: string,
  results: Accepted[],
): Promise<{ uncovered: string[]; releaseHolderId: string | null }> {
  const brought = await commitsBetween(ctx, repo, base, commit);
  if (!brought) return { uncovered: [`The commits between main ${base} and ${commit} could not all be read.`], releaseHolderId: null };
  const uncovered: string[] = [];
  const checked = new Set<string>();
  for (const result of results) {
    const flaw = result.turnkey ? await turnkeyResultCoverage(ctx, repo, turn, base, result, checked) : await candidateResultCoverage(ctx, repo, result, checked);
    if (flaw) uncovered.push(flaw);
  }
  const extra = brought.filter(c => !checked.has(c.sha));
  if (!extra.length) return { uncovered, releaseHolderId: null };
  if (await activeTurnkeyReleaseHolder(ctx, repo, releaseTask, agentId, commit)) return { uncovered, releaseHolderId: agentId };
  return { uncovered: [...uncovered, ...extraneousCommitNotes(extra)], releaseHolderId: null };
}

export type ReleaseInput = { task: number; commit: string; runId: string };

type ReleaseScope = { task: Task; target: IntegrationTarget; turn: Turn };

function requireOpenReleaseHolder(task: Task | null, ref: number, agentId: string): Task {
  if (!task) throw refuse(404, 'task_unknown', `There is no task #${ref}.`);
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours: only the holder of the release task records the release.`);
  if (task.status === 'done' || task.status === 'cancelled') throw refuse(409, 'task_invalid', `#${task.number} is closed.`);
  if (task.paused) throw refuse(409, 'task_paused', `#${task.number} is paused. It records no release until it is resumed.`);
  return task;
}

async function resolveReleaseScope(ctx: Reader, agentId: string, companyId: string, taskRef: number): Promise<ReleaseScope> {
  const task = requireOpenReleaseHolder(await taskByRef(ctx, companyId, taskRef), taskRef, agentId);
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const target = await integrationTarget(ctx, task);
  const turn = target?.turn;
  if (!target || !turn) throw refuse(409, 'repo_invalid', `#${task.number} is of no department that releases turns: its results go to their main line straight.`);
  if (!agent || agent.departmentId !== turn.departmentId) throw refuse(403, 'task_not_yours', 'Only the department whose turn it is records its release.');
  return { task, target, turn };
}

async function requireReleaseCommits(ctx: Reader, target: IntegrationTarget, commit: string): Promise<string> {
  const head = await headOf(ctx, target.repo, target.branch);
  if (head !== commit) throw refuse(409, 'task_changed', `${commit} is not the head of ${target.branch}${head ? `, which is at ${head}` : ', or it could not be read'}. A release is the head of the turn branch.`);
  const base = await headOf(ctx, target.repo, target.repo.branch);
  if (!base) throw refuse(409, 'repo_invalid', `${target.repo.branch} could not be read. Try again.`);
  if (base === commit || await branchHolds(ctx, target.repo, base, commit)) throw refuse(409, 'task_invalid', `${target.repo.branch} already holds ${commit}: a release is recorded before main moves.`);
  if (!(await branchHolds(ctx, target.repo, commit, base))) throw refuse(409, 'task_invalid', `${commit} does not hold ${target.repo.branch} at ${base}, so main cannot go to it by fast-forward. Take ${target.repo.branch} into ${target.branch} first.`);
  return base;
}

async function ensureReleaseAuthorization(ctx: Reader, scope: ReleaseScope, commit: string, uncovered: string[]): Promise<void> {
  if (await personApproval(ctx.db, scope.task, commit)) return;
  if (!(await autonomousOn(ctx.db, scope.turn.departmentId!, scope.target.repo))) throw needsPerson(scope.task, commit, '');
  if (uncovered.length) {
    throw needsPerson(scope.task, commit, ` Autonomous release approves only a release every commit of which was checked, and this one brings what was not: ${uncovered.join(' ')}`);
  }
}

function toReleasedTasks(results: Accepted[]): ReleasedTask[] {
  return results.map(r => ({
    taskId: r.task.id,
    number: r.task.number,
    commit: r.commit,
    verdicts: r.verdicts,
    ...(r.turnkeyAgentId ? { turnkeyAgentId: r.turnkeyAgentId } : {}),
  }));
}

async function verifySameTurnTasks(tx: Tx, turn: Turn, released: ReleasedTask[]): Promise<void> {
  const [open] = await tx.select({ id: turns.id }).from(turns).where(and(eq(turns.id, turn.id), eq(turns.status, 'open')));
  if (!open) throw refuse(409, 'task_changed', `Turn ${turn.number} was released meanwhile.`);
  const still = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.turnId, turn.id));
  if (still.length !== released.length || still.some(row => !released.some(r => r.taskId === row.id))) {
    throw refuse(409, 'task_changed', `A result joined turn ${turn.number} meanwhile. Record the release again.`);
  }
}

async function resolveApprovalInTx(
  tx: Tx,
  scope: ReleaseScope,
  agentId: string,
  input: ReleaseInput,
  base: string,
  released: ReleasedTask[],
  releaseHolderId: string | null,
): Promise<{ approvalRequestId: string | null; autonomousReleaseId: string | null }> {
  const approvalRequestId = await personApproval(tx, scope.task, input.commit);
  if (approvalRequestId) return { approvalRequestId, autonomousReleaseId: null };
  if (!(await autonomousOn(tx, scope.turn.departmentId!, scope.target.repo, true))) {
    throw needsPerson(scope.task, input.commit, ' Autonomous release was turned off meanwhile.');
  }
  const autonomousReleaseId = await logAutonomous(tx, scope.turn, scope.task, agentId, input.commit, base, input.runId, released, releaseHolderId);
  if (!autonomousReleaseId) throw needsPerson(scope.task, input.commit, ' A checker of what it brings is no longer at work, so autonomous release cannot approve it.');
  return { approvalRequestId: null, autonomousReleaseId };
}

/* The record of a release, asked by the holder of its release task in the turn's department before main moves. */
export async function recordRelease(ctx: Reader, agentId: string, companyId: string, input: ReleaseInput) {
  const scope = await resolveReleaseScope(ctx, agentId, companyId, input.task);
  const base = await requireReleaseCommits(ctx, scope.target, input.commit);
  await requireFullRun(ctx.db, scope.turn, scope.target.branch, scope.turn.departmentId!, input.runId, input.commit);
  const results = await acceptedResults(ctx.db, scope.turn);
  const { uncovered, releaseHolderId } = await coverage(ctx, scope.target.repo, scope.turn, scope.task, agentId, base, input.commit, results);
  const released = toReleasedTasks(results);
  /* A person's approval stands first; without one, autonomous release approves only what was checked whole. */
  await ensureReleaseAuthorization(ctx, scope, input.commit, uncovered);
  const record = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    await verifySameTurnTasks(tx, scope.turn, released);
    await requireFullRun(tx, scope.turn, scope.target.branch, scope.turn.departmentId!, input.runId, input.commit);
    const { approvalRequestId, autonomousReleaseId } = await resolveApprovalInTx(tx, scope, agentId, input, base, released, releaseHolderId);
    const [row] = await tx.insert(turnReleases).values({
      companyId, turnId: scope.turn.id, commit: input.commit, baseCommitSha: base, runId: input.runId, tasks: released, taskId: scope.task.id,
      approvalRequestId, autonomousReleaseId, requestedByAgentId: agentId, covered: uncovered.length === 0, uncovered,
    }).returning();
    const by = autonomousReleaseId ? ', approved by autonomous release' : '';
    const noteData = releaseHolderId ? { release: row!.id, releaseHolderAgentId: releaseHolderId } : { release: row!.id };
    await note(tx, scope.task, { kind: 'comment', actor: { agentId }, text: `Recorded the release of Turn ${scope.turn.number}: main ${base} goes to ${input.commit}${by}.`, data: noteData });
    return row!;
  });
  return releaseView(scope.turn, record, released);
}

async function passingTurnFullRun(db: Ctx['db'], turn: Turn, branch: string, commit: string): Promise<{ id: string; number: number } | null> {
  const runs = await db.select({ id: testRuns.id, number: testRuns.number }).from(testRuns)
    .where(and(eq(testRuns.companyId, turn.companyId), eq(testRuns.departmentId, turn.departmentId!), eq(testRuns.branch, branch), eq(testRuns.commitSha, commit), eq(testRuns.status, 'passed')))
    .orderBy(desc(testRuns.createdAt), desc(testRuns.number)).limit(10);
  for (const run of runs) {
    try {
      await requireFullRun(db, turn, branch, turn.departmentId!, run.id, commit);
      return run;
    } catch {
      /* Try earlier run on the same commit if any. */
    }
  }
  return null;
}

function isOpenReleaseTaskFor(task: Task, agentId: string): boolean {
  if (task.assigneeAgentId !== agentId || Boolean(task.paused) || Boolean(task.productId) || !task.departmentId) return false;
  return task.status !== 'done' && task.status !== 'cancelled';
}

async function matchesTurnDepartment(db: Ctx['db'], agentId: string, turn: Turn, target: IntegrationTarget | null): Promise<target is IntegrationTarget> {
  if (!target?.turn || target.turn.id !== turn.id) return false;
  const [agent] = await db.select({ departmentId: agents.departmentId }).from(agents).where(eq(agents.id, agentId));
  return agent?.departmentId === turn.departmentId;
}

async function openTurnScopeFor(ctx: Reader, task: Task, agentId: string): Promise<ReleaseScope | null> {
  if (!isOpenReleaseTaskFor(task, agentId)) return null;
  const turn = await openTurnOf(ctx.db, task.companyId, task.departmentId);
  if (!turn) return null;
  const target = await integrationTarget(ctx, task);
  if (!(await matchesTurnDepartment(ctx.db, agentId, turn, target))) return null;
  return (await autonomousOn(ctx.db, turn.departmentId!, target.repo)) ? { task, target, turn } : null;
}

async function readyTurnBase(ctx: Reader, target: IntegrationTarget, commit: string): Promise<string | null> {
  if ((await headOf(ctx, target.repo, target.branch)) !== commit) return null;
  const base = await headOf(ctx, target.repo, target.repo.branch);
  if (!base || base === commit || (await branchHolds(ctx, target.repo, base, commit))) return null;
  return (await branchHolds(ctx, target.repo, commit, base)) ? base : null;
}

async function readyTurnScopeAndRun(
  ctx: Reader,
  task: Task,
  agentId: string,
  commit: string,
): Promise<{ scope: ReleaseScope; base: string; run: { id: string; number: number } } | null> {
  const scope = await openTurnScopeFor(ctx, task, agentId);
  if (!scope) return null;
  const base = await readyTurnBase(ctx, scope.target, commit);
  if (!base) return null;
  const run = await passingTurnFullRun(ctx.db, scope.turn, scope.target.branch, commit);
  return run ? { scope, base, run } : null;
}

/* Whether a turn release task's commit on turn-<number> already satisfies every condition of autonomous release_turn. */
export async function autonomousTurnReleaseReady(
  ctx: Reader,
  task: Task,
  agentId: string,
  commit: string,
): Promise<{ turnNumber: number; runId: string; runNumber: number } | null> {
  const ready = await readyTurnScopeAndRun(ctx, task, agentId, commit);
  if (!ready) return null;
  const results = await acceptedResults(ctx.db, ready.scope.turn);
  const { uncovered, releaseHolderId } = await coverage(ctx, ready.scope.target.repo, ready.scope.turn, task, agentId, ready.base, commit, results);
  if (uncovered.length) return null;
  const live = await liveCheckers(ctx.db, ready.scope.turn.companyId, toReleasedTasks(results), releaseHolderId);
  return live ? { turnNumber: ready.scope.turn.number, runId: ready.run.id, runNumber: ready.run.number } : null;
}

const releaseView = (turn: Turn, record: Release, released: ReleasedTask[]) => ({
  release: record.id, turn: turn.number, commit: record.commit, baseCommit: record.baseCommitSha, runId: record.runId, approvalRequestId: record.approvalRequestId, autonomousReleaseId: record.autonomousReleaseId,
  tasks: released.map(({ number, commit, verdicts }) => ({ number, commit, verdicts })), covered: record.covered, uncovered: record.uncovered,
  next: `Fast-forward main to ${record.commit} and tag it vX.Y.Z: the tag closes Turn ${turn.number}.`,
});

/* One department's open turn on its repository's tags: the first look takes the newest tag as where the turn starts; a newer
   tag of a release recorded before main moved, on its exact commit and from where the turn started, closes it. A newer tag of
   its line that no standing record names releases nothing: the turn stays open, and its head and the CEO hear of it once. */
async function releaseOne(ctx: Reader, turn: Turn, repo: Repo): Promise<void> {
  if (!ctx.readTags) return;
  const before = (await ctx.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.turnId, turn.id))).map(row => row.id).sort();
  const read = await ctx.readTags(repo, 30_000);
  if ('problem' in read) return;
  const versions = Object.entries(read.tags).filter(([name]) => versionOf(name)).sort(([a], [b]) => newerVersion(a, b) ? -1 : newerVersion(b, a) ? 1 : 0);
  if (!turn.baseVersion) {
    const [newest] = versions;
    if (newest) await ctx.db.update(turns).set({ baseVersion: newest[0], baseCommit: newest[1] }).where(and(eq(turns.id, turn.id), eq(turns.status, 'open'), isNull(turns.baseVersion)));
    return;
  }
  const records = await ctx.db.select().from(turnReleases).where(eq(turnReleases.turnId, turn.id)).orderBy(desc(turnReleases.createdAt));
  for (const [name, commit] of versions) {
    if (!newerVersion(name, turn.baseVersion)) return;
    if (turn.baseCommit && !(await branchHolds(ctx, repo, commit, turn.baseCommit))) continue;
    const record = records.find(r => r.commit === commit && r.baseCommitSha !== commit);
    if (!record || !(await branchHolds(ctx, repo, commit, record.baseCommitSha))) {
      await tellOfTag(ctx, turn, name, commit, 'unrecorded');
      continue;
    }
    const head = await headOf(ctx, repo, `turn-${turn.number}`);
    if (!head || !(await branchHolds(ctx, repo, head, commit))) return;
    if (await closeTurn(ctx, repo, turn, record, name, head, before) === 'stale') await tellOfTag(ctx, turn, name, commit, 'stale');
    return;
  }
}

/* What a tag that released nothing says, to the head of the department and to the CEO, once for each tag on its commit. The CEO's
   card goes on the first goal of the turn, as its summary would; a turn with nothing in it holds nothing back from a release, so
   only its head hears. */
async function tellOfTag(ctx: Reader, turn: Turn, version: string, commit: string, why: 'unrecorded' | 'stale'): Promise<void> {
  const [goal] = await ctx.db.select().from(tasks).where(and(eq(tasks.turnId, turn.id), isNull(tasks.parentId))).orderBy(asc(tasks.number)).limit(1);
  const [head] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, turn.companyId), eq(agents.departmentId, turn.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).limit(1);
  const [ceo] = await ctx.db.select({ id: people.id }).from(people).where(and(eq(people.companyId, turn.companyId), eq(people.isOwner, true), eq(people.status, 'active'))).limit(1);
  const on = goal ? [{ id: goal.id, number: goal.number }] : [];
  const cause = why === 'unrecorded'
    ? `no release of it was recorded before main moved`
    : `the full run or the approval its release record relied on no longer stands`;
  const key = `release_tag:${turn.departmentId}:${version}:${commit}`;
  const notification = { source: 'release_tag' as const, tasks: on };
  if (head) await recordWaitNotice(ctx.db, {
    companyId: turn.companyId, agentId: head.id, personId: null, dedupKey: `${key}:head`, guard: { tasks: [] },
    message: { personId: null, notification, text: `${version} was tagged on ${commit}, newer than ${turn.baseVersion} where Turn ${turn.number} started, but ${cause}. Turn ${turn.number} stays open, and none of its results counts as released. Find out how this tag came to be. The turn is released only by the tag of a release recorded with release_turn before main moves, on its exact commit.` },
  });
  if (ceo && goal) await recordWaitNotice(ctx.db, {
    companyId: turn.companyId, agentId: null, personId: ceo.id, dedupKey: `${key}:ceo`, guard: { tasks: [], turn: { id: turn.id, taskId: goal.id }, tag: { version, commit, why } },
    message: { personId: null, notification, text: `Version ${version} was marked in the code, but ${why === 'unrecorded' ? 'its release was not recorded and approved beforehand' : 'the full check or the approval its release relied on no longer holds'}. So the tasks of Turn ${turn.number} are not counted as released, and the turn stays open. The head of the department was told.` },
  });
  ctx.log?.warn({ companyId: turn.companyId, turn: turn.number, version, commit, why }, `${version} released nothing of Turn ${turn.number}: ${cause}.`);
}

async function recordedReleaseHolder(tx: Tx, record: Release): Promise<string | null> {
  if (!record.taskId) return null;
  const [event] = await tx.select({ holder: sql<string | null>`${taskEvents.data}->>'releaseHolderAgentId'` }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, record.taskId), eq(taskEvents.kind, 'comment'), sql`${taskEvents.data}->>'release' = ${record.id}`)).limit(1);
  return event?.holder ?? null;
}

async function autonomousRecordStands(tx: Tx, turn: Turn, record: Release): Promise<boolean> {
  if (!record.autonomousReleaseId || !record.covered) return false;
  const [department] = await tx.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, turn.departmentId!)).for('share');
  const [entry] = await tx.select({ id: autonomousReleases.id }).from(autonomousReleases).where(and(eq(autonomousReleases.id, record.autonomousReleaseId), eq(autonomousReleases.commitSha, record.commit)));
  if (!department?.on || !entry) return false;
  const releaseHolderId = await recordedReleaseHolder(tx, record);
  return (await liveCheckers(tx, turn.companyId, record.tasks, releaseHolderId)) !== null;
}

/* The full run and the approval the record relies on still stand as they stood: the person's approval of its commit, or the
   entry of the autonomous release log, while autonomous release is on and every checker or turnkey executor it relied on is still at work. */
async function recordStands(tx: Tx, turn: Turn, record: Release): Promise<boolean> {
  if (!record.runId) return false;
  try { await requireFullRun(tx, turn, `turn-${turn.number}`, turn.departmentId!, record.runId, record.commit); }
  catch { return false; }
  if (!record.approvalRequestId) return autonomousRecordStands(tx, turn, record);
  const [approval] = await tx.select({ id: requests.id }).from(requests).where(and(eq(requests.id, record.approvalRequestId), eq(requests.status, 'approved'),
    eq(requests.kind, 'approval'), eq(requests.commit, record.commit), isNotNull(requests.answeredBy), isNotNull(requests.answeredAt)));
  return !!approval;
}

/* The tag closes the turn: it keeps the version and commit, the results of its record stay in it, and every other result of it,
   one accepted while the repository was read too, goes into the next turn, which starts from the head of this one, and its
   branch is made there. Anything that joined the turn after it was first read puts the close off to the next minute, so the
   head read holds it. */
async function closeTurn(ctx: Reader, repo: Repo, turn: Turn, record: Release, version: string, head: string, before: string[]): Promise<'closed' | 'later' | 'stale'> {
  const closed = await ctx.db.transaction(async tx => {
    await lockCompany(tx, turn.companyId);
    const rows = await tx.select().from(tasks).where(eq(tasks.turnId, turn.id)).orderBy(asc(tasks.number)).for('no key update');
    if (rows.map(row => row.id).sort().join() !== before.join()) return 'later' as const;
    const [open] = await tx.select().from(turns).where(and(eq(turns.id, turn.id), eq(turns.status, 'open')));
    if (!open) return 'later' as const;
    if (!(await recordStands(tx, turn, record))) return 'stale' as const;
    const [done] = await tx.update(turns).set({ status: 'closed', version, commit: record.commit, closedAt: new Date() }).where(eq(turns.id, turn.id)).returning();
    await keepSnapshot(tx, done!, ctx.log);
    await recordTurnSummary(tx, done!);
    const number = (await lastTurnNumber(tx, turn.companyId)) + 1;
    const [next] = await tx.insert(turns).values({ companyId: turn.companyId, departmentId: turn.departmentId, number, goal: 'The next release.', status: 'open', openedAt: new Date(), baseVersion: version, baseCommit: record.commit, startCommit: head }).returning();
    const released = new Set(record.tasks.map(t => t.taskId));
    const left = rows.filter(row => !released.has(row.id));
    if (left.length) await tx.update(tasks).set({ turnId: next!.id }).where(inArray(tasks.id, left.map(row => row.id)));
    const by = record.requestedByAgentId;
    if (by) for (const row of left) await note(tx, row, { kind: 'updated', actor: { agentId: by }, text: `${version} was released without it, so it goes into Turn ${next!.number}.`, data: { fields: ['turn'], from: turn.number, to: next!.number } });
    return { done: done!, next: next! };
  });
  if (typeof closed === 'string') return closed;
  ctx.bus.publish(turn.companyId, { type: 'org' });
  ctx.log?.info({ companyId: turn.companyId, turn: turn.number, version, next: closed.next.number, startCommit: head }, `Turn ${turn.number} was released as ${version}; turn-${closed.next.number} starts from ${head}.`);
  /* A branch that could not be made now is made before the first result joins the next turn. */
  const branch = await ensureTurnBranch(ctx, repo, closed.next);
  if ('problem' in branch) ctx.log?.warn({ companyId: turn.companyId, turn: closed.next.number }, `turn-${closed.next.number} was not made: ${branch.problem}`);
  else ctx.log?.info({ companyId: turn.companyId, turn: closed.next.number, head: branch.head, made: branch.made }, branch.made ? `turn-${closed.next.number} was made from ${branch.head}.` : `turn-${closed.next.number} was there already, at ${branch.head}.`);
  return 'closed';
}

/* Every minute: each department that keeps a repository, on its tags. One department's trouble keeps no other from it. */
export async function releaseRound(ctx: Reader): Promise<void> {
  if (!ctx.config || !ctx.readTags) return;
  const open = await ctx.db.select().from(turns).innerJoin(departments, eq(departments.id, turns.departmentId))
    .where(and(eq(turns.status, 'open'), isNull(departments.parentId), isNotNull(departments.repoUrl)));
  for (const { turns: turn } of open) {
    try {
      const target = await integrationTarget(ctx, { companyId: turn.companyId, productId: null, departmentId: turn.departmentId });
      if (target?.turn?.id === turn.id) await releaseOne(ctx, turn, target.repo);
    } catch (err) {
      ctx.log?.error({ error: loggable(err), companyId: turn.companyId, turn: turn.number }, 'Looking for the release of a turn failed.');
    }
  }
}

export type { Release };
