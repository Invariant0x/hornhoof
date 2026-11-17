import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Ctx } from '../../app.js';
import { agents, teams } from '../../db/schema.js';
import { changeRoute, type Route } from './echelons-store.js';
import { giver, move, refuse, type Moved, type Task, type Tx } from './engine.js';
import { integrationTarget, requireInTurn, requireSameTurn } from './turn-integration.js';

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

type Reader = Parameters<typeof move>[0] & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;

/* Where turnkey work of a department with a repository joins its open turn: its own branch, task-<number>, which the turn
   branch holds by fast-forward. Work with no branch of its own changed no code and joins no release. */
async function turnkeyIntegration(ctx: Reader, task: Task) {
  const target = await integrationTarget(ctx, task);
  const turn = target?.turn;
  if (!target || !turn || !ctx.readCommit) return null;
  let own: Awaited<ReturnType<Ctx['readCommit']>>;
  try { own = await ctx.readCommit(target.repo, { task: task.number }, 5_000); }
  catch { throw refuse(409, 'task_changed', `The branch of #${task.number} could not be read. Try again.`); }
  if ('problem' in own) return null;
  const { branch } = target;
  await requireInTurn(ctx, { ...target, turn }, own.commitSha, (head, holdsHead) => holdsHead
    ? `fast-forward ${branch} to ${own.branch} first, so the release takes it, then report done.`
    : `${own.branch} does not hold ${head}, the head of ${branch}, so ${branch} cannot go to it by fast-forward: take ${branch} into ${own.branch} first, then fast-forward ${branch} to it and report done.`);
  return { turn, integration: { branch: target.branch, commit: own.commitSha, from: own.branch, observedAt: new Date().toISOString() } };
}

/* Its holder closes turnkey work alone: nobody checks it after, and whoever gave it hears that it is done. */
export async function turnkeyReport(ctx: Reader, task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours to report.`);
  const text = summary.trim();
  if (!text) throw refuse(400, 'task_invalid', 'Say what was done and how it was checked.');
  const joined = await turnkeyIntegration(ctx, task);
  const wakes = giver(task, 'done', agentId, text);
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0, ...(joined ? { turnId: joined.turn.id } : {}) }, {
    kind: 'report', actor: { agentId }, text, data: { done: true, ...(joined ? { integration: joined.integration } : {}) }, returned: true,
  }, async tx => {
    if (joined) await requireSameTurn(tx, task, joined.turn, joined.integration.commit);
    await changeRoute(tx, route, { ...route.state, phase: 'done' });
  }, wakes);
  return { task: row, wakes };
}
