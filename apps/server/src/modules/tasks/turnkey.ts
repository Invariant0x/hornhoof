import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Ctx } from '../../app.js';
import { agents, taskEvents, taskRoutes, teams } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { repoAt } from '../departments/repository.js';
import { withRepoCompany } from '../testruns/github-limit.js';
import { requireRecorded, type Recorded } from './recorded.js';
import { changeRoute, type Route } from './route-records.js';
import { giver, refuse, type Live, type Moved, type Task, type Tx } from './state.js';
import { move } from './transitions.js';
import { openTurnOf } from './turn-department.js';
import { branchHolds, integrationTarget, requireInTurn, requireSameTurn, type BranchProofReader, type IntegrationTarget } from './turn-integration.js';

/* A turnkey team: each member does a task end to end alone on its task branch with local changed-area checks (never
   per-task run_tests), never enters the echelons and calls no other member of the department onto its work. The mark is
   data on the team, never read from a name or from a task's text. */
export async function turnkeyTeamOf(db: Db | Tx, companyId: string, agentId: string | null): Promise<{ id: string; name: string } | null> {
  if (!agentId) return null;
  const [team] = await db.select({ id: teams.id, name: teams.name }).from(agents)
    .innerJoin(teams, and(eq(teams.id, agents.teamId), eq(teams.companyId, companyId), eq(teams.turnkey, true)))
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.removedAt)));
  return team ?? null;
}

/* Whether work goes through the echelons, decided once as its task is made and never changed after, by the team of who
   holds it: a member of a turnkey team does it end to end alone, everybody else's goes through the route of its department.
   Every rule of which work skips them belongs here. */
export async function echelonsFor(db: Db | Tx, at: { companyId: string; holderId: string | null }): Promise<boolean> {
  return !(await turnkeyTeamOf(db, at.companyId, at.holderId));
}

/* The same asked while it is still decided what kind of task to make. */
export const wouldGoThroughEchelons = echelonsFor;

export const throughEchelons = (db: Db | Tx, task: Pick<Task, 'companyId' | 'executorAgentId' | 'assigneeAgentId'>) =>
  echelonsFor(db, { companyId: task.companyId, holderId: task.executorAgentId ?? task.assigneeAgentId });

export const turnkeyWork = (task: Pick<Task, 'number'>) =>
  refuse(409, 'task_invalid', `#${task.number} is turnkey work: its holder does it end to end alone and closes it with report, so no echelon takes it.`);

type Reader = BranchProofReader & Parameters<typeof move>[0];

/* What the holder of turnkey work names as it closes it: the exact commit it checked and took into the turn branch by
   fast-forward, a commit it made on its own branch, and the commit right under its first own commit, which is another
   branch's commit where it built on one. A release counts as checked only the first-parent line from that commit down to
   that start: a commit someone else made under it or on top of it stays unchecked. */
export type TurnkeyChecked = { commit: string; baseCommit: string };

/* The words the report contract and its refusals use for what the holder names. */
export const CHECKED_COMMIT = 'exact commit you checked and fast-forwarded the turn branch to: a commit you made on your own branch, never a merge made on the turn branch';
export const START_COMMIT = 'commit right under your first own commit: where you built on another branch\'s commit, that commit';

type Own = { branch: string; commitSha: string };

const unnamed = (task: Task, own: Own, branch: string) => refuse(400, 'task_invalid', `Name what you checked as you close #${task.number}: turnkey.commit, the exact commit of ${own.branch} you checked and fast-forwarded ${branch} to, and turnkey.baseCommit, the ${START_COMMIT}. A release counts as checked only the first-parent line from that commit down to that start.`);

/* The commit named is one of the work's own branch, and it holds the start named: else the line between them is nobody's. The
   turn branch holds that commit, so it holds the start too. */
async function requireNamed(ctx: Reader, repo: IntegrationTarget['repo'], own: Own, named: TurnkeyChecked): Promise<void> {
  if (!(await branchHolds(ctx, repo, own.commitSha, named.commit))) throw refuse(409, 'task_changed', `${own.branch} is at ${own.commitSha}, which does not hold ${named.commit}. Name the commit of ${own.branch} you checked.`);
  if (!(await branchHolds(ctx, repo, named.commit, named.baseCommit))) throw refuse(409, 'task_invalid', `${named.commit} does not hold ${named.baseCommit}. Name as turnkey.baseCommit the ${START_COMMIT}.`);
}

/* Where the turn branch of its department, and main, were as turnkey work started, as the server read them then: turn is the
   turn open then and turnHead its branch's head, none where it had no turn or its branch was not made yet. */
export type WorkStart = { turn: number | null; turnHead: string | null; main: string | null };

type Repo = IntegrationTarget['repo'];

/* The head of a branch: null where the repository has no such branch, undefined where it could not say, or said a tag. */
async function headAt(readCommit: NonNullable<Live['readCommit']>, repo: Repo, branch: string): Promise<string | null | undefined> {
  try {
    const at = await readCommit(repo, { branch }, 5_000);
    if ('problem' in at) return at.missing ? null : undefined;
    return at.branch === branch && !at.tag ? at.commitSha : undefined;
  } catch {
    return undefined;
  }
}

type StartingTask = Pick<Task, 'id' | 'companyId' | 'productId' | 'departmentId' | 'status' | 'assigneeAgentId'>;

/* What the status note of work that starts now keeps of where it started: turnkey work of a department that releases turns,
   taken up by its holder, keeps where the turn branch and main were. */
export async function workStartNote(ctx: Live, task: StartingTask, agentId: string): Promise<{ start?: WorkStart }> {
  if (task.status !== 'open' || task.assigneeAgentId !== agentId) return {};
  const start = await workStartOf(ctx, task);
  return start ? { start } : {};
}

/* Where turnkey work of a department that releases turns starts from, read as its work starts: none for other work, for work of
   a repository with no turns, or where the head of the turn branch could not be read. The holder's branch starts there or
   later, so nothing the turn branch held then is its own. */
async function workStartOf(ctx: Live, task: StartingTask): Promise<WorkStart | null> {
  if (!ctx.config || !ctx.readCommit) return null;
  const at = await turnkeyRepo(ctx.db, ctx.config, task);
  return at ? readWorkStart(ctx.readCommit, at.repo, at.turn) : null;
}

type Turn = NonNullable<Awaited<ReturnType<typeof openTurnOf>>>;

/* The repository and open turn, if any, of turnkey work of a department that releases turns. */
async function turnkeyRepo(db: Live['db'], config: NonNullable<Live['config']>, task: StartingTask): Promise<{ repo: Repo; turn: Turn | null } | null> {
  const [route] = await db.select(only(taskRoutes, 'state')).from(taskRoutes).where(and(eq(taskRoutes.taskId, task.id), eq(taskRoutes.companyId, task.companyId)));
  if (route?.state.resultKind !== 'turnkey') return null;
  const found = await repoAt({ db, config }, [task.productId, task.departmentId]);
  if (!found || found.department.parentId) return null;
  return { repo: withRepoCompany(found.repo, task.companyId), turn: await openTurnOf(db, task.companyId, found.department.id) };
}

/* The heads of the turn branch and main now: none where the turn branch could not be read, or neither is there. */
async function readWorkStart(readCommit: NonNullable<Live['readCommit']>, repo: Repo, turn: Turn | null): Promise<WorkStart | null> {
  const [turnHead, main] = await Promise.all([turn ? headAt(readCommit, repo, `turn-${turn.number}`) : null, headAt(readCommit, repo, repo.branch)]);
  if (turnHead === undefined || (!turnHead && !main)) return null;
  return { turn: turn?.number ?? null, turnHead, main: main ?? null };
}

/* The commit every start named for the work must hold: the head of the turn branch as the work first started, else main's. */
async function startedAt(db: Db | Tx, task: Task): Promise<{ commit: string; at: string } | null> {
  const [first] = await db.select(only(taskEvents, 'data')).from(taskEvents)
    .where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'status'), sql`${taskEvents.data} ? 'start'`)).orderBy(asc(taskEvents.id)).limit(1);
  const start = first?.data.start as WorkStart | undefined;
  if (start?.turnHead) return { commit: start.turnHead, at: `turn-${start.turn}` };
  return start?.main ? { commit: start.main, at: 'main' } : null;
}

/* The start named holds where the work started: a start under it would count as checked commits that were there before. */
async function requireStarted(ctx: Reader, repo: Repo, task: Task, named: TurnkeyChecked): Promise<string | null> {
  const started = await startedAt(ctx.db, task);
  if (started && !(await branchHolds(ctx, repo, named.baseCommit, started.commit))) throw refuse(409, 'task_invalid', `${named.baseCommit} does not hold ${started.commit}, where ${started.at} was as your work on #${task.number} started, so your branch started there or later. Name as turnkey.baseCommit the ${START_COMMIT}.`);
  return started?.commit ?? null;
}

/* The work's own branch, task-<number>, as the repository says it is now: none where the repository has no such branch. */
async function ownBranchOf(readCommit: NonNullable<Ctx['readCommit']>, repo: IntegrationTarget['repo'], task: Task): Promise<Own | null> {
  const unreadable = () => refuse(409, 'task_changed', `The branch of #${task.number} could not be read. Try again.`);
  let own: Awaited<ReturnType<Ctx['readCommit']>>;
  try { own = await readCommit(repo, { task: task.number }, 5_000); }
  catch { throw unreadable(); }
  if (!('problem' in own)) return own;
  if (own.missing) return null;
  throw unreadable();
}

/* Where turnkey work of a department with a repository joins its open turn: its own branch, task-<number>, which the turn
   branch holds by fast-forward. Work with no branch of its own changed no code and joins no release. */
async function turnkeyIntegration(ctx: Reader, task: Task, named?: TurnkeyChecked) {
  const target = await integrationTarget(ctx, task);
  const turn = target?.turn;
  if (!target || !turn || !ctx.readCommit) return null;
  const own = await ownBranchOf(ctx.readCommit, target.repo, task);
  if (!own) return null;
  const { branch } = target;
  if (!named) throw unnamed(task, own, branch);
  await requireNamed(ctx, target.repo, own, named);
  const workStart = await requireStarted(ctx, target.repo, task, named);
  await requireInTurn(ctx, { ...target, turn }, named.commit, (head, holdsHead) => holdsHead
    ? `fast-forward ${branch} to ${own.branch} first, so the release takes it, then report done.`
    : `${own.branch} does not hold ${head}, the head of ${branch}, so ${branch} cannot go to it by fast-forward: take ${branch} into ${own.branch} first, then fast-forward ${branch} to it and report done.`);
  return { turn, integration: { branch, commit: named.commit, start: named.baseCommit, workStart, from: own.branch, observedAt: new Date().toISOString() } };
}

/* Its holder closes turnkey work alone: nobody checks it after, and whoever gave it hears that it is done. */
export async function turnkeyReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, named?: TurnkeyChecked, recorded?: Recorded): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours to report.`);
  const text = summary.trim();
  if (!text) throw refuse(400, 'task_invalid', 'Say what was done and how it was checked.');
  const joined = await turnkeyIntegration(ctx, task, named);
  /* Work that joined no turn changed no code: its result is recorded somewhere a colleague finds it, or it is not done. */
  const where = joined ? undefined : await requireRecorded(ctx, task, recorded);
  const wakes = giver(task, 'done', agentId, text);
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0, ...(joined ? { turnId: joined.turn.id } : {}) }, {
    kind: 'report', actor: { agentId }, text, data: { done: true, ...(joined ? { integration: joined.integration } : {}), ...(where ? { recorded: where } : {}) }, returned: true,
  }, async tx => {
    if (joined) await requireSameTurn(tx, task, joined.turn, joined.integration.commit);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}
