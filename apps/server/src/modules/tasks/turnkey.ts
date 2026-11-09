import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { agents, teams } from '../../db/schema.js';
import { changeRoute, type Route } from './echelons-store.js';
import { giver, move, refuse, type Moved, type Task, type Tx } from './engine.js';

/* A turnkey team: each member does a task end to end alone, from code and checks to merge and release, never enters the
   echelons and calls no other member of the department onto its work. The mark is data on the team, never read from a name
   or from a task's text. */
export async function turnkeyTeamOf(db: Db | Tx, companyId: string, agentId: string | null): Promise<{ id: string; name: string } | null> {
  if (!agentId) return null;
  const [team] = await db.select({ id: teams.id, name: teams.name }).from(agents)
    .innerJoin(teams, and(eq(teams.id, agents.teamId), eq(teams.companyId, companyId), eq(teams.turnkey, true)))
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.removedAt)));
  return team ?? null;
}

/* Whether a task goes through the echelons, decided once as it is made. Every rule of which work skips them belongs here. */
export async function throughEchelons(db: Db | Tx, task: Pick<Task, 'companyId' | 'executorAgentId' | 'assigneeAgentId'>): Promise<boolean> {
  return !(await turnkeyTeamOf(db, task.companyId, task.executorAgentId ?? task.assigneeAgentId));
}

export const turnkeyWork = (task: Pick<Task, 'number'>) =>
  refuse(409, 'task_invalid', `#${task.number} is turnkey work: its holder does it end to end alone and closes it with report, so no echelon takes it.`);

/* Its holder closes turnkey work alone: nobody checks it after, and whoever gave it hears that it is done. */
export async function turnkeyReport(ctx: Parameters<typeof move>[0], task: Task, route: Route, agentId: string, summary: string): Promise<Moved> {
  if (task.assigneeAgentId !== agentId) throw refuse(403, 'task_not_yours', `#${task.number} is not yours to report.`);
  const text = summary.trim();
  if (!text) throw refuse(400, 'task_invalid', 'Say what was done and how it was checked.');
  const wakes = giver(task, 'done', agentId, text);
  const row = await move(ctx, task, { status: 'done', closedAt: new Date(), assigneeAgentId: null, silent: 0 }, {
    kind: 'report', actor: { agentId }, text, data: { done: true }, returned: true,
  }, tx => changeRoute(tx, route, { ...route.state, phase: 'done' }), wakes);
  return { task: row, wakes };
}
