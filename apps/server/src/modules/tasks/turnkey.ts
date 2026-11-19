import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Ctx } from '../../app.js';
import { agents, teams } from '../../db/schema.js';
import { changeRoute, type Route } from './route-records.js';
import { giver, refuse, type Moved, type Task, type Tx } from './state.js';
import { move } from './transitions.js';
import { branchHolds, integrationTarget, requireInTurn, requireSameTurn, type IntegrationTarget } from './turn-integration.js';

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

type Reader = Parameters<typeof move>[0] & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare' | 'readMerged'>>;

/* What the holder of turnkey work names as it closes it: the exact commit it checked and took into the turn branch by
   fast-forward, and the commit of main or the turn branch its branch started from. A release counts as checked only the
   first-parent line from that commit down to that start: a commit someone else made under it or on top of it stays unchecked. */
export type TurnkeyChecked = { commit: string; baseCommit: string };

type Own = { branch: string; commitSha: string };

const unnamed = (task: Task, own: Own, branch: string) => refuse(400, 'task_invalid', `Name what you checked as you close #${task.number}: turnkey.commit, the exact commit of ${own.branch} you checked and fast-forwarded ${branch} to, and turnkey.baseCommit, the commit of main or ${branch} your branch started from. A release counts as checked only the first-parent line from that commit down to that start.`);

/* The commit named is one of the work's own branch, and it holds the start named: else the line between them is nobody's. The
   turn branch holds that commit, so it holds the start too. */
async function requireNamed(ctx: Reader, repo: IntegrationTarget['repo'], own: Own, named: TurnkeyChecked): Promise<void> {
  if (!(await branchHolds(ctx, repo, own.commitSha, named.commit))) throw refuse(409, 'task_changed', `${own.branch} is at ${own.commitSha}, which does not hold ${named.commit}. Name the commit of ${own.branch} you checked.`);
  if (!(await branchHolds(ctx, repo, named.commit, named.baseCommit))) throw refuse(409, 'task_invalid', `${named.commit} does not hold ${named.baseCommit}. Name as turnkey.baseCommit the commit of main or the turn branch your branch started from.`);
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
  await requireInTurn(ctx, { ...target, turn }, named.commit, (head, holdsHead) => holdsHead
    ? `fast-forward ${branch} to ${own.branch} first, so the release takes it, then report done.`
    : `${own.branch} does not hold ${head}, the head of ${branch}, so ${branch} cannot go to it by fast-forward: take ${branch} into ${own.branch} first, then fast-forward ${branch} to it and report done.`);
  return { turn, integration: { branch, commit: named.commit, start: named.baseCommit, from: own.branch, observedAt: new Date().toISOString() } };
}

/* Its holder closes turnkey work alone: nobody checks it after, and whoever gave it hears that it is done. */
export async function turnkeyReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string, named?: TurnkeyChecked): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours to report.`);
  const text = summary.trim();
  if (!text) throw refuse(400, 'task_invalid', 'Say what was done and how it was checked.');
  const joined = await turnkeyIntegration(ctx, task, named);
  const wakes = giver(task, 'done', agentId, text);
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0, ...(joined ? { turnId: joined.turn.id } : {}) }, {
    kind: 'report', actor: { agentId }, text, data: { done: true, ...(joined ? { integration: joined.integration } : {}) }, returned: true,
  }, async tx => {
    if (joined) await requireSameTurn(tx, task, joined.turn, joined.integration.commit);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}
