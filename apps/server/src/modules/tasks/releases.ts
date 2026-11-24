import { EchelonCandidate } from '@hornhoof/protocol/echelons';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, autonomousReleases, ciDispatches, companies, departments, people, taskEvents, taskRoutes, tasks, turnReleases, turns, type ReleasedTask } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { note } from './events.js';
import { refuse, type Task, type Tx } from './state.js';
import { taskByRef } from './lookup.js';
import { keepSnapshot } from './pipeline-report.js';
import { commitApprovalNaming, commitApprovalRequired, exactCommitApproval } from './commit-approval.js';
import { uncheckedLine, uncheckedLines, type UncheckedItem } from './unchecked.js';
import { recordTurnSummary } from './wait-goals.js';
import { lastTurnNumber } from './numbers.js';
import { recordWaitNotice } from './wait-notices.js';
import { branchHolds, ensureTurnBranch, headOf, integrationTarget, recordOfTag, type IntegrationTarget } from './turn-integration.js';
import { newerVersion, versionsNewestFirst } from './turn-tags.js';
import { openTurnOf } from './turn-department.js';
import { repoAt } from '../departments/repository.js';
import { heldLineage } from '../testruns/compare.js';
import { requireCi, type CiResult } from './release-ci.js';
import { startCi, type CiStarted } from './release-dispatch.js';

/* A turn is a release of its department. Its holder records the release before main moves: the exact commit R of
   turn-<number>, its head or one the branch went past while R was checked, main under it, what the repository's CI says of R
   (green, or none where the repository has no CI), the results R brings with the verdicts on them, and any exact approval
   required by its department. Autonomous release can record proof
   from independent checkers or, for turnkey work, from the holder's own review, security check and tests.
   Main then goes to R by fast-forward and R
   is tagged vX.Y.Z; the minute round closes the turn on that tag, and what the release left out goes into the next turn,
   whose branch starts from the head of this one. */

type Turn = typeof turns.$inferSelect;
type Release = typeof turnReleases.$inferSelect;
type Reader = Pick<Ctx, 'db' | 'bus'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare' | 'readCi' | 'dispatchCi' | 'readTags' | 'readBranches' | 'createBranch' | 'log'>>;
type Repo = IntegrationTarget['repo'];

const lockCompany = (tx: Tx, companyId: string) => tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('no key update');

const needsPerson = (task: Task, commit: string, why: string) =>
  refuse(403, 'decision_not_allowed', `The department requires approval of exactly ${commit}. Use ask_person with that commit on #${task.number}.${why}`);

/* A release that brings what no check covers reaches main only once a person approved a card that named exactly that,
   whatever the commit rule of its department, and autonomous release never approves it. */
const unseen = (task: Task, commit: string, uncovered: UncheckedItem[], autonomous: boolean) =>
  refuse(403, 'decision_not_allowed', `A person approves exactly ${commit} before main moves, on a card that names what it brings that no check covers, whatever the department's commit rule. Use ask_person with that commit on #${task.number}: Hornhoof names it on the card, next to Approve.${autonomous ? ' Autonomous release needs proof for each change, and this one brings what was not: ' : ' It brings what was not checked: '}${uncovered.map(uncheckedLine).join(' ')}`);

/* The department has autonomous release on, held so a switch of its people waits for the record, for a repository whose main
   line is main. */
async function autonomousOn(db: Ctx['db'] | Tx, departmentId: string, repo: Repo, hold = false): Promise<boolean> {
  const query = db.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, departmentId));
  const [department] = hold ? await query.for('share') : await query;
  return !!department?.on && repo.branch === 'main';
}

/* Who passed the results of a release: checkers by their verdicts on the exact commits, and holders of turnkey work by the
   reports they closed it with after their own checks, at stage turnkey. Each still at work, or null. */
async function liveCheckers(db: Ctx['db'] | Tx, released: ReleasedTask[]): Promise<{ id: string; name: string; stage: string }[] | null> {
  const events = (ids: string[], kind: 'verdict' | 'report') => ids.map(Number).filter(Number.isSafeInteger).map(id => [id, kind] as const);
  const kinds = new Map([...events(released.flatMap(r => r.verdicts), 'verdict'), ...events(released.flatMap(r => r.report ? [r.report] : []), 'report')]);
  if (!kinds.size) return null;
  const rows = await db.select({ id: taskEvents.id, kind: taskEvents.kind, agentId: agents.id, name: agents.name, removedAt: agents.removedAt, switchedOffAt: agents.switchedOffAt, stage: sql<string>`coalesce(${taskEvents.data}->>'stage', 'review')` })
    .from(taskEvents).innerJoin(agents, eq(agents.id, taskEvents.agentId)).where(inArray(taskEvents.id, [...kinds.keys()])).orderBy(asc(taskEvents.id));
  if (rows.length !== kinds.size || rows.some(row => kinds.get(row.id) !== row.kind || row.removedAt || row.switchedOffAt)) return null;
  return rows.map(row => ({ id: row.agentId, name: row.name, stage: row.kind === 'report' ? 'turnkey' : row.stage }));
}

/* The entry of the autonomous release log that approves R: the release task, its holder, R and main under it, what the
   repository's CI said of R, and the checkers that passed what R brings, the holders of its turnkey work among them. */
async function logAutonomous(tx: Tx, turn: Turn, task: Task, agentId: string, commit: string, base: string, ci: CiResult, released: ReleasedTask[]): Promise<string | null> {
  const checkers = await liveCheckers(tx, released);
  const [holder] = await tx.select(only(agents, 'name')).from(agents).where(eq(agents.id, agentId));
  if (!checkers || !holder) return null;
  const unique = <T,>(items: T[]) => [...new Set(items)];
  const ids = unique(checkers.map(c => c.id));
  const [entry] = await tx.insert(autonomousReleases).values({
    companyId: turn.companyId, departmentId: turn.departmentId, taskId: task.id, taskNumber: task.number, agentId, agentName: holder.name, commitSha: commit, baseCommitSha: base,
    ...ciColumns(ci), reviewerAgentId: ids.length === 1 ? ids[0]! : null, reviewerName: unique(checkers.map(c => c.name)).join(', '), verdictStage: unique(checkers.map(c => c.stage)).join(', '),
  }).returning({ id: autonomousReleases.id });
  return entry!.id;
}

/* The commits of a comparison, however many files it lists, or null where they could not all be read. */
async function commitsBetween(ctx: Reader, repo: Repo, base: string, head: string) {
  try {
    const compared = await ctx.readCompare?.(repo, { base, head }, 10_000);
    return (compared && heldLineage(compared, base, head)?.commits) ?? null;
  } catch {
    return null;
  }
}

/* Turnkey work as its report closed it: start is the commit its holder named as where its branch started, none on a report
   from before holders named it; workStart the head of the turn branch, or main's, as the server read it when the work started,
   none where it could not or the work started before the server noted it. */
type Turnkey = { report: string; live: boolean; start: string | null; workStart: string | null };
type Accepted = { task: Task; commit: string; candidate: EchelonCandidate | null; verdicts: string[]; checkersLive: boolean; turnkey: Turnkey | null };

/* What each result of the turn was accepted as, and the passing verdicts of its last checkers on that exact commit. Turnkey work
   has no checker: its holder did it whole with its own review, security check and tests, and closed it with the report that
   joined it to the turn branch, which stands for those checks while that holder is at work. */
async function acceptedResults(db: Ctx['db'], turn: Turn): Promise<Accepted[]> {
  const rows = await db.select().from(tasks).where(and(eq(tasks.companyId, turn.companyId), eq(tasks.turnId, turn.id))).orderBy(asc(tasks.number));
  const out: Accepted[] = [];
  for (const task of rows) {
    const [report] = await db.select({ id: taskEvents.id, agentId: taskEvents.agentId, data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'report'), sql`(${taskEvents.data} ? 'acceptedCandidate' OR ${taskEvents.data} ? 'integration')`)).orderBy(desc(taskEvents.id)).limit(1);
    const accepted = report?.data.acceptedCandidate as { candidateId?: string; commit?: string } | undefined;
    const integration = report?.data.integration as { commit?: string } | undefined;
    const [route] = await db.select().from(taskRoutes).where(eq(taskRoutes.taskId, task.id));
    const stages = (route?.state.stages ?? []).filter(step => (step.stage === 'review' || step.stage === 'security') && step.status === 'complete');
    const candidate = accepted?.candidateId ? await candidateOf(db, task, accepted.candidateId) : null;
    const commit = accepted?.commit ?? integration?.commit ?? '';
    const verdicts = candidate ? await passingVerdicts(db, task, candidate) : [];
    const owners = stages.map(step => step.ownerAgentId).filter((id): id is string => !!id);
    const live = owners.length ? await db.select(idOnly(agents)).from(agents).where(and(inArray(agents.id, owners), isNull(agents.removedAt), isNull(agents.switchedOffAt))) : [];
    const checkersLive = !!candidate && stages.length > 0 && live.length === new Set(owners).size && owners.every(id => id !== candidate.producedBy.agentId);
    const turnkey = route?.state.resultKind === 'turnkey' && report ? await turnkeyOf(db, report) : null;
    out.push({ task, commit, candidate, verdicts, checkersLive, turnkey });
  }
  return out;
}

type Closing = Pick<typeof taskEvents.$inferSelect, 'id' | 'agentId' | 'data'>;

/* Turnkey work as the last report of its holder closed it, joining it to the turn branch: whether that holder is at work, and
   the commit it named as where its branch started. None where that report closed nothing. */
async function turnkeyOf(db: Ctx['db'], report: Closing): Promise<Turnkey | null> {
  const integration = report.data.integration as { commit?: string; start?: string; workStart?: string | null } | undefined;
  if (report.data.done !== true || !integration?.commit || !report.agentId) return null;
  const atWork = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.id, report.agentId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return { report: String(report.id), live: atWork.length > 0, start: integration.start ?? null, workStart: integration.workStart ?? null };
}

async function candidateOf(db: Ctx['db'], task: Task, candidateId: string): Promise<EchelonCandidate | null> {
  const handed = await db.select(only(taskEvents, 'data')).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'submitted'), sql`${taskEvents.data}->'candidate'->>'id' = ${candidateId}`)).limit(1);
  const parsed = EchelonCandidate.safeParse(handed[0]?.data.candidate);
  return parsed.success ? parsed.data : null;
}

async function passingVerdicts(db: Ctx['db'], task: Task, candidate: EchelonCandidate): Promise<string[]> {
  const rows = await db.select(idOnly(taskEvents)).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict'),
    sql`(${taskEvents.data}->>'pass')::boolean`, sql`${taskEvents.data}->>'reviewedCommit' = ${candidate.commit}`)).orderBy(asc(taskEvents.id));
  return rows.map(row => String(row.id));
}

/* The results of the turn R holds: the turn branch goes on joining work while R is checked and approved, and what came after R
   waits for the next release. A result with no commit of its own changed no code and goes with R. */
async function heldBy(ctx: Reader, repo: Repo, commit: string, results: Accepted[]): Promise<Accepted[]> {
  const held: Accepted[] = [];
  for (const result of results) if (!result.commit || await branchHolds(ctx, repo, commit, result.commit)) held.push(result);
  return held;
}

/* Whether every commit R brings over main is of a result of the turn whose checks passed: a candidate whose checkers passed its
   exact commit, or turnkey work its holder checked itself. A merge made on the turn branch outside all of them, a commit no
   result brought, other work with no checked candidate, a checker or turnkey holder off since, or a comparison that could not
   be read whole, is not covered. Only a covered release may be approved by itself. */
async function coverage(ctx: Reader, repo: Repo, base: string, commit: string, results: Accepted[]): Promise<UncheckedItem[]> {
  const brought = await commitsBetween(ctx, repo, base, commit);
  if (!brought) return [{ kind: 'unread', base, commit }];
  const uncovered: UncheckedItem[] = [];
  const checked = new Set<string>();
  for (const result of results) {
    if (result.turnkey) {
      uncovered.push(...turnkeyGaps(result.task, result.turnkey));
      continue;
    }
    if (!result.candidate) { uncovered.push({ kind: 'no_candidate', task: result.task.number }); continue; }
    if (!result.verdicts.length || !result.checkersLive) uncovered.push({ kind: 'checker', task: result.task.number, commit: result.candidate.commit });
    const own = await commitsBetween(ctx, repo, result.candidate.baseCommit, result.candidate.commit);
    if (!own) { uncovered.push({ kind: 'task_unread', task: result.task.number }); continue; }
    for (const c of own) checked.add(c.sha);
  }
  for (const sha of turnkeyCommits(brought, turnkeyLines(results), checked)) checked.add(sha);
  for (const c of brought) {
    if (checked.has(c.sha)) continue;
    uncovered.push({ kind: c.parents.length > 1 ? 'merge' : 'commit', commit: c.sha });
  }
  return uncovered;
}

/* The line each turnkey work's holder checked: from the commit it named down to where its branch started, never under where
   the turn branch was as the work started. Work with either start missing has none. */
const turnkeyLines = (results: Accepted[]) => results.flatMap(r => (r.turnkey?.start && r.turnkey.workStart ? [{ tip: r.commit, start: r.turnkey.start, workStart: r.turnkey.workStart }] : []));

/* What turnkey work leaves to a person by itself: a holder off since, a report that named nothing it checked, or work whose
   start the server has no record of. */
function turnkeyGaps(task: Task, turnkey: Turnkey): UncheckedItem[] {
  return [
    ...(turnkey.live ? [] : [{ kind: 'holder_off' as const, task: task.number }]),
    ...(turnkey.start ? [] : [{ kind: 'unpinned' as const, task: task.number }]),
    ...(!turnkey.start || turnkey.workStart ? [] : [{ kind: 'unstarted' as const, task: task.number }]),
  ];
}

/* The results of the turn the release R holds, and what R brings over main at base that no check of theirs covers. */
async function broughtBy(ctx: Reader, turn: Turn, repo: Repo, base: string, commit: string) {
  const results = await acceptedResults(ctx.db, turn);
  const held = await heldBy(ctx, repo, commit, results);
  return { results, held, uncovered: await coverage(ctx, repo, base, commit, held) };
}

/* The repository and the open turn of the department of task, where it releases turns: none for a product or a part of a
   department that keeps a repository of its own, or a department with no open turn. It opens none. */
async function openRelease(ctx: Reader, task: Pick<Task, 'companyId' | 'productId' | 'departmentId'>): Promise<{ repo: Repo; turn: Turn } | null> {
  const found = ctx.config ? await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]) : null;
  if (!found || found.department.parentId) return null;
  const turn = await openTurnOf(ctx.db, task.companyId, found.department.id);
  /* The repository as CI is read and started on it: with the release workflow its settings name. */
  const repo = { ...found.repo, releaseWorkflow: found.department.repoReleaseWorkflow };
  return turn ? { repo, turn } : null;
}

/* Main's head under commit, where commit is a release of the turn branch: the branch holds it, main does not yet, and main can
   go to it by fast-forward. None otherwise, or where any of that could not be read. */
async function mainUnder(ctx: Reader, repo: Repo, branch: string, commit: string): Promise<string | null> {
  const [head, base] = [await headOf(ctx, repo, branch), await headOf(ctx, repo, repo.branch)];
  if (!head || !base || base === commit) return null;
  const releases = await branchHolds(ctx, repo, head, commit) && !(await branchHolds(ctx, repo, base, commit)) && await branchHolds(ctx, repo, commit, base);
  return releases ? base : null;
}

/* What a release of commit by the department of task brings that no check covers, as its approval card names it: null where
   commit is no release of its department's open turn, or where that could not be read. Recording the release reads it again
   and refuses on its own. */
export async function uncheckedInRelease(ctx: Reader, task: Pick<Task, 'companyId' | 'productId' | 'departmentId'>, commit: string): Promise<UncheckedItem[] | null> {
  const at = await openRelease(ctx, task);
  const base = at ? await mainUnder(ctx, at.repo, `turn-${at.turn.number}`, commit) : null;
  return at && base ? (await broughtBy(ctx, at.turn, at.repo, base, commit)).uncovered : null;
}

type ReleaseAt = { task: Task; turn: Turn; repo: Repo; commit: string; uncovered: UncheckedItem[] };
type ReleaseApproval = { approvalRequestId: string | null; canLog: boolean };

/* A person saw what nobody checked: the newest approval of R whose card Hornhoof wrote exactly that on, beside Approve. */
async function seenApproval(db: Ctx['db'] | Tx, { task, turn, repo, commit, uncovered }: ReleaseAt, hold: boolean): Promise<ReleaseApproval> {
  const approvalRequestId = await commitApprovalNaming(db, task.companyId, task.id, commit, uncheckedLines(uncovered));
  if (approvalRequestId) return { approvalRequestId, canLog: false };
  const autonomous = await commitApprovalRequired(db, task.companyId, turn.departmentId, hold) && await autonomousOn(db, turn.departmentId!, repo, hold);
  throw unseen(task, commit, uncovered, autonomous);
}

/* What lets R go to main: where it brings what no check covers, a person's approval of a card that named exactly that; else a
   person's approval of R, a department that asks none, or autonomous release, which logs it. Read again, held, as it is recorded. */
async function releaseApproval(db: Ctx['db'] | Tx, at: ReleaseAt, hold = false): Promise<ReleaseApproval> {
  if (at.uncovered.length) return seenApproval(db, at, hold);
  const { task, turn, commit } = at;
  const approvalRequestId = await exactCommitApproval(db, task.companyId, task.id, commit);
  if (approvalRequestId || !(await commitApprovalRequired(db, task.companyId, turn.departmentId, hold))) return { approvalRequestId, canLog: false };
  if (!(await autonomousOn(db, turn.departmentId!, at.repo, hold))) throw needsPerson(task, commit, '');
  return { approvalRequestId, canLog: true };
}

type Compared = { sha: string; parents: string[] };

/* The commits over main that turnkey work brings, from the commit each holder checked (tip), the commit its branch started
   from (start) and where the turn branch was as its work started (workStart), and the commits other results brought (others).
   Its own are the commits down the first parents of its tip, to one the start or workStart holds, another result brought or
   main holds. A merge on its branch took the turn branch in from its other side,
   which is not its own; a commit on top of its tip, or a merge on the turn branch that joined it there, is no commit it checked. */
function turnkeyCommits(brought: Compared[], lines: { tip: string; start: string; workStart: string }[], others: Set<string>): Set<string> {
  const at = new Map(brought.map(c => [c.sha, c]));
  const own = new Set<string>();
  for (const { tip, start, workStart } of lines) {
    const under = heldWithin(at, [start, workStart]);
    const line = new Set<string>();
    for (let sha = tip; at.has(sha) && !others.has(sha) && !under.has(sha) && !line.has(sha); sha = at.get(sha)!.parents[0] ?? '') line.add(sha);
    for (const sha of line) own.add(sha);
  }
  return own;
}

/* The commits of a comparison the given ones hold, themselves too. */
function heldWithin(at: Map<string, Compared>, from: string[]): Set<string> {
  const held = new Set<string>();
  for (const stack = [...from]; stack.length;) {
    const sha = stack.pop()!;
    const c = at.get(sha);
    if (!c || held.has(sha)) continue;
    held.add(sha);
    stack.push(...c.parents);
  }
  return held;
}

export type ReleaseInput = { task: number; commit: string };

/* The CI result as the columns of a record keep it: the number of checks only where it was green. */
const ciColumns = (ci: CiResult) => ({ ciState: ci.state, ciChecks: ci.state === 'green' ? ci.checks : null });

/* The release task the asking holder holds and may record on: a refusal where it is no task of theirs, is closed or paused. */
async function holderTask(ctx: Reader, agentId: string, companyId: string, ref: number): Promise<Task> {
  const task = await taskByRef(ctx, companyId, ref);
  if (!task) throw refuse(404, 'task_unknown', `There is no task #${ref}.`);
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours: only the holder of the release task records the release.`);
  if (task.status === 'done' || task.status === 'cancelled') throw refuse(409, 'task_invalid', `#${task.number} is closed.`);
  if (task.paused) throw refuse(409, 'task_paused', `#${task.number} is paused. It records no release until it is resumed.`);
  return task;
}

/* Where the task's department releases its open turn, for the agent of that department: a refusal for any other. */
async function releaseTarget(ctx: Reader, task: Task, agentId: string): Promise<IntegrationTarget & { turn: Turn }> {
  const [agent] = await ctx.db.select().from(agents).where(eq(agents.id, agentId));
  const target = await integrationTarget(ctx, task);
  if (!target?.turn) throw refuse(409, 'repo_invalid', `#${task.number} is of no department that releases turns: its results go to their main line straight.`);
  if (!agent || agent.departmentId !== target.turn.departmentId) throw refuse(403, 'task_not_yours', 'Only the department whose turn it is records its release.');
  return { ...target, turn: target.turn };
}

/* The record the minute round made of this commit while it waited for CI, which a holder asking again is answered with. */
async function recordedByRound(ctx: Reader, companyId: string, turnId: string, commit: string): Promise<Release | undefined> {
  const [round] = await ctx.db.select({ release: ciDispatches.releaseId }).from(ciDispatches).where(and(eq(ciDispatches.companyId, companyId), eq(ciDispatches.commit, commit), eq(ciDispatches.state, 'recorded')));
  if (!round?.release) return undefined;
  const [kept] = await ctx.db.select().from(turnReleases).where(and(eq(turnReleases.id, round.release), eq(turnReleases.turnId, turnId)));
  return kept;
}

/* The record of a release, asked by the holder of its release task in the turn's department before main moves. */
export async function recordRelease(ctx: Reader, agentId: string, companyId: string, input: ReleaseInput) {
  const task = await holderTask(ctx, agentId, companyId, input.task);
  const target = await releaseTarget(ctx, task, agentId);
  const turn = target.turn;
  const head = await headOf(ctx, target.repo, target.branch);
  if (!head || !(await branchHolds(ctx, target.repo, head, input.commit))) throw refuse(409, 'task_changed', `${target.branch} does not hold ${input.commit}${head ? `: it is at ${head}` : ', or it could not be read'}. A release is a commit of the turn branch.`);
  const base = await headOf(ctx, target.repo, target.repo.branch);
  if (!base) throw refuse(409, 'repo_invalid', `${target.repo.branch} could not be read. Try again.`);
  if (base === input.commit || await branchHolds(ctx, target.repo, base, input.commit)) throw refuse(409, 'task_invalid', `${target.repo.branch} already holds ${input.commit}: a release is recorded before main moves.`);
  if (!(await branchHolds(ctx, target.repo, input.commit, base))) throw refuse(409, 'task_invalid', `${input.commit} does not hold ${target.repo.branch} at ${base}, so main cannot go to it by fast-forward. Take ${target.repo.branch} into ${target.branch} first.`);
  const { results, held, uncovered } = await broughtBy(ctx, turn, target.repo, base, input.commit);
  const released: ReleasedTask[] = held.map(r => ({ taskId: r.task.id, number: r.task.number, commit: r.commit, verdicts: r.verdicts, ...(r.turnkey ? { report: r.turnkey.report } : {}) }));
  const left = results.filter(r => !held.includes(r)).map(r => r.task.number);
  const at: ReleaseAt = { task, turn, repo: target.repo, commit: input.commit, uncovered };
  const kept = await recordedByRound(ctx, companyId, turn.id, input.commit);
  if (kept) return releaseView(turn, kept, released, left, await lastVersion(ctx, turn, target.repo));
  await releaseApproval(ctx.db, at);
  const ci = await requireCi(ctx, target.repo, input.commit);
  if (ci.state === 'absent') return startedView(await startCi(ctx, { task, turnId: turn.id, agentId, repo: target.repo, branch: target.branch, commit: input.commit, head }), turn, input.commit, target.branch);
  const record = await ctx.db.transaction(async tx => {
    await lockCompany(tx, companyId);
    const [open] = await tx.select(idOnly(turns)).from(turns).where(and(eq(turns.id, turn.id), eq(turns.status, 'open')));
    if (!open) throw refuse(409, 'task_changed', `Turn ${turn.number} was released meanwhile.`);
    const still = await tx.select(idOnly(tasks)).from(tasks).where(eq(tasks.turnId, turn.id));
    if (still.length !== results.length || still.some(row => !results.some(r => r.task.id === row.id))) throw refuse(409, 'task_changed', `A result joined turn ${turn.number} meanwhile. Record the release again.`);
    const { approvalRequestId, canLog } = await releaseApproval(tx, at, true);
    const autonomousReleaseId = canLog ? await logAutonomous(tx, turn, task, agentId, input.commit, base, ci, released) : null;
    if (canLog && !autonomousReleaseId) throw needsPerson(task, input.commit, ' A checker of what it brings is no longer at work.');
    const [row] = await tx.insert(turnReleases).values({ companyId, turnId: turn.id, commit: input.commit, baseCommitSha: base, ...ciColumns(ci), tasks: released, taskId: task.id, approvalRequestId, autonomousReleaseId, requestedByAgentId: agentId, covered: uncovered.length === 0, uncovered: uncheckedLines(uncovered) }).returning();
    const by = autonomousReleaseId ? ', approved by autonomous release' : '';
    await note(tx, task, { kind: 'comment', actor: { agentId }, text: `Recorded the release of Turn ${turn.number}: main ${base} goes to ${input.commit}${by}.`, data: { release: row!.id } });
    return row!;
  });
  return releaseView(turn, record, released, left, await lastVersion(ctx, turn, target.repo));
}

/* The answer to a release asked for on a commit no CI run is on yet: the server started CI, and nothing is recorded. The minute
   round records the release when CI is green on that exact commit, and the holder hears of it. */
const startedView = (started: CiStarted, turn: Turn, commit: string, branch: string) => ({
  recorded: false, turn: turn.number, commit,
  ci: { state: 'started', workflow: started.workflow, run: started.run, url: started.url },
  next: `CI ${started.again ? 'was started on this commit already' : 'started'}${started.run ? `, run ${started.run}` : ''}; the release records when it's green. `
    + `${started.workflow ? `The workflow is ${started.workflow}, on ${branch} at ${commit}. ` : ''}Nothing is recorded yet: the minute round records the release if CI is green on that exact commit and tells you, or tells you why it did not. Start no run yourself and record nothing by hand.`,
});

/* The last version tag of the repository's own line, which its next release goes on from: the one the turn started at, or,
   before the round first looked, the newest one the repository has now. Its turn number and any other repository's version
   set nothing. last is null for a repository with no version tag yet; none comes back where its tags could not be read. */
type Line = { last: string | null } | null;
async function lastVersion(ctx: Reader, turn: Turn, repo: Repo): Promise<Line> {
  if (turn.baseVersion) return { last: turn.baseVersion };
  const read = await ctx.readTags?.(repo, 30_000).catch(() => null);
  if (!read || 'problem' in read) return null;
  return { last: versionsNewestFirst(read.tags)[0]?.[0] ?? null };
}

const nextTag = (line: Line): string =>
  !line ? 'newer than the last version tag of this repository'
    : line.last ? `the next version after ${line.last}, the last version tag of this repository`
      : 'the first version tag of this repository, which has none yet';

/* What the repository's CI said of the commit as it was recorded; none for a record of before releases relied on CI. */
const ciView = (record: Release) => (record.ciState === 'green' ? { state: 'green', checks: record.ciChecks } : record.ciState ? { state: record.ciState } : null);

const releaseView = (turn: Turn, record: Release, released: ReleasedTask[], left: number[], line: Line) => ({
  release: record.id, turn: turn.number, commit: record.commit, baseCommit: record.baseCommitSha, ci: ciView(record), approvalRequestId: record.approvalRequestId, autonomousReleaseId: record.autonomousReleaseId,
  tasks: released.map(({ number, commit, verdicts }) => ({ number, commit, verdicts })), covered: record.covered, uncovered: record.uncovered, left,
  next: `Fast-forward main to ${record.commit} and tag it vX.Y.Z, ${nextTag(line)}: the tag closes Turn ${turn.number}${left.length ? `, and what it leaves out goes into the next release` : ''}.`,
});

/* One department's open turn on the tags of its own repository, its own line of versions: the first look takes the newest tag
   as where the turn starts; a newer tag of a release recorded before main moved, on its exact commit and from where the turn
   started, closes it. A newer tag of its line that no standing record names releases nothing: the turn stays open, and its head
   and the CEO hear of it once. A repository that had no version tag as the turn started comes out with its first one, such
   as v1.4.0 or v2026.11.0: before the first look took any tag, a tag on the commit of a release recorded in the turn closes it. */
async function releaseOne(ctx: Reader, turn: Turn, repo: Repo): Promise<void> {
  if (!ctx.readTags) return;
  const before = (await ctx.db.select(idOnly(tasks)).from(tasks).where(eq(tasks.turnId, turn.id))).map(row => row.id).sort();
  const read = await ctx.readTags(repo, 30_000);
  if ('problem' in read) return;
  const tagged = versionsNewestFirst(read.tags);
  const records = await ctx.db.select().from(turnReleases).where(eq(turnReleases.turnId, turn.id)).orderBy(desc(turnReleases.createdAt));
  const versions = turn.baseVersion ? tagged : tagged.filter(([, commit]) => records.some(r => r.commit === commit));
  if (!turn.baseVersion && !versions.length) {
    const [newest] = tagged;
    if (newest) await ctx.db.update(turns).set({ baseVersion: newest[0], baseCommit: newest[1] }).where(and(eq(turns.id, turn.id), eq(turns.status, 'open'), isNull(turns.baseVersion)));
    return;
  }
  for (const [name, commit] of versions) {
    if (turn.baseVersion && !newerVersion(name, turn.baseVersion)) return;
    if (turn.baseCommit && !(await branchHolds(ctx, repo, commit, turn.baseCommit))) continue;
    const record = await recordOfTag(ctx, repo, records, commit);
    if (!record) {
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
  const [head] = await ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, turn.companyId), eq(agents.departmentId, turn.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt))).limit(1);
  const [ceo] = await ctx.db.select(idOnly(people)).from(people).where(and(eq(people.companyId, turn.companyId), eq(people.isOwner, true), eq(people.status, 'active'))).limit(1);
  const on = goal ? [{ id: goal.id, number: goal.number }] : [];
  const cause = why === 'unrecorded'
    ? `no release of it was recorded before main moved`
    : `the approval its release record relied on no longer stands`;
  const key = `release_tag:${turn.departmentId}:${version}:${commit}`;
  const notification = { source: 'release_tag' as const, tasks: on };
  const which = turn.baseVersion ? `newer than ${turn.baseVersion} where Turn ${turn.number} started` : `the first version tag of the repository of Turn ${turn.number}`;
  if (head) await recordWaitNotice(ctx.db, {
    companyId: turn.companyId, agentId: head.id, personId: null, dedupKey: `${key}:head`, guard: { tasks: [] },
    message: { personId: null, notification, text: `${version} was tagged on ${commit}, ${which}, but ${cause}. Turn ${turn.number} stays open, and none of its results counts as released. Find out how this tag came to be. The turn is released only by the tag of a release recorded with release_turn before main moves, on its exact commit.` },
  });
  if (ceo && goal) await recordWaitNotice(ctx.db, {
    companyId: turn.companyId, agentId: null, personId: ceo.id, dedupKey: `${key}:ceo`, guard: { tasks: [], turn: { id: turn.id, taskId: goal.id }, tag: { version, commit, why } },
    message: { personId: null, notification, text: `Version ${version} was marked in the code, but ${why === 'unrecorded' ? 'its release was not recorded and approved beforehand' : 'the approval its release relied on no longer holds'}. So the tasks of Turn ${turn.number} are not counted as released, and the turn stays open. The head of the department was told.` },
  });
  ctx.log?.warn({ companyId: turn.companyId, turn: turn.number, version, commit, why }, `${version} released nothing of Turn ${turn.number}: ${cause}.`);
}

/* The approval a record relied on still stands: of its commit, and where it brought what no check covers, of the card Hornhoof
   named exactly that on. */
const approvalStands = (tx: Tx, turn: Turn, record: Release, taskId: string, requestId: string): Promise<string | null> => record.covered
  ? exactCommitApproval(tx, turn.companyId, taskId, record.commit, requestId)
  : commitApprovalNaming(tx, turn.companyId, taskId, record.commit, record.uncovered, requestId);

/* The approval the record relied on still stands. A record never stands or falls by a run of Hornhoof's machines or by the
   repository's CI read again: what the host said of the commit was read as the release was recorded. A record that kept
   neither a CI result nor a run is none. A release recorded without approval still follows the department's commit rule. */
async function recordStands(tx: Tx, turn: Turn, record: Release): Promise<boolean> {
  if (!record.runId && !record.ciState) return false;
  if (record.approvalRequestId) return Boolean(record.taskId && await approvalStands(tx, turn, record, record.taskId, record.approvalRequestId));
  if (!record.autonomousReleaseId) return !(await commitApprovalRequired(tx, turn.companyId, turn.departmentId, true));
  if (!record.covered) return false;
  const [department] = await tx.select({ on: departments.autonomousRelease }).from(departments).where(eq(departments.id, turn.departmentId!)).for('share');
  const [entry] = await tx.select(idOnly(autonomousReleases)).from(autonomousReleases).where(and(eq(autonomousReleases.id, record.autonomousReleaseId), eq(autonomousReleases.commitSha, record.commit)));
  return !!department?.on && !!entry && (await liveCheckers(tx, record.tasks)) !== null;
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
  await makeBranchOf(ctx, repo, closed.next);
  return 'closed';
}

/* The branch of the turn just opened, from where it starts. One that could not be made now is made before the first result
   joins the turn. */
async function makeBranchOf(ctx: Reader, repo: Repo, turn: Turn): Promise<void> {
  const branch = await ensureTurnBranch(ctx, repo, turn);
  const at = { companyId: turn.companyId, turn: turn.number };
  if ('problem' in branch) ctx.log?.warn(at, `turn-${turn.number} was not made: ${branch.problem}`);
  else ctx.log?.info({ ...at, head: branch.head, made: branch.made }, branch.made ? `turn-${turn.number} was made from ${branch.head}.` : `turn-${turn.number} was there already, at ${branch.head}.`);
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
