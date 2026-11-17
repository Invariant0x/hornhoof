import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { actsAsCeo } from '../../auth/decisions.js';
import { runsDepartment } from '../../auth/departments.js';
import type { Db } from '../../db/client.js';
import { agents, companies, people, tasks, teams } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { CLOSED, loadTask, note, published, refuse, type Actor, type Moved, type Task, type Tx } from './engine.js';
import { freePeers, type Work } from './role-peers.js';

/* Whether work is urgent is data: the CEO or a department's owner says so through the orchestrator or a route, and nothing
   is read from its words. Work under a task is as urgent as it is. A team may take urgent work only, and who is in it says
   who that holds for. */

/* What the filters that give out work ask. It looks at nothing but these two, and leaves work a holder already has alone. */
export const mayHoldTask = ({ urgent }: Pick<Task, 'urgent'>, { urgentOnly }: { urgentOnly: boolean }): boolean => urgent || !urgentOnly;

/* Those of these agents in a team that takes only urgent work, as they stand now. */
export async function urgentOnlyAgents(db: Db | Tx, companyId: string, agentIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (!agentIds.length) return new Set();
  const rows = await db
    .select(idOnly(agents))
    .from(agents)
    .innerJoin(teams, and(eq(teams.id, agents.teamId), eq(teams.companyId, companyId)))
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds]), eq(teams.urgentOnly, true)));
  return new Set(rows.map(row => row.id));
}

/* A person acting as the CEO sees everyone, as agents who give out work do. Anyone else may not see who works where. */
async function seesEveryone(db: Db | Tx, companyId: string, actor: Actor): Promise<boolean> {
  if (actor.agentId !== undefined) return true;
  const [person] = await db.select().from(people).where(and(eq(people.id, actor.personId), eq(people.companyId, companyId)));
  return Boolean(person && actsAsCeo(person));
}

const NOT_URGENT = 'takes only urgent work, and this work is not urgent';

async function notForThem(ctx: Ctx, actor: Actor, companyId: string, work: Work, agentId: string): Promise<ApiError> {
  if (!(await seesEveryone(ctx.db, companyId, actor))) return new ApiError(409, 'conflict', `The team of this employee ${NOT_URGENT}.`, 'urgent_only_team');
  const [found] = await ctx.db.select({ agent: agents, team: teams.name }).from(agents).innerJoin(teams, eq(teams.id, agents.teamId)).where(eq(agents.id, agentId));
  const { agent, team } = found!;
  const free = agent.departmentId && agent.roleKey ? await freePeers(ctx, { id: agent.id, departmentId: agent.departmentId, roleKey: agent.roleKey }, work) : [];
  const who = free.length ? `Free now in the same role: ${free.map(p => `${p.name} (${p.id})`).join(', ')}.` : 'Nobody else in the same role is free now.';
  return new ApiError(409, 'conflict', `${agent.name} is in ${team}, which ${NOT_URGENT}. ${who}`, 'urgent_only_team', { free });
}

/* The one check of everything that gives work to someone new, before it is written. A change of urgency or of the team on
   its way ends the same as when the work came just before it: what someone holds stays theirs. */
export async function refuseNotUrgent(ctx: Ctx, actor: Actor, companyId: string, work: Work & Pick<Task, 'urgent'>, takers: readonly string[]): Promise<void> {
  const only = await urgentOnlyAgents(ctx.db, companyId, takers);
  const who = takers.find(id => !mayHoldTask(work, { urgentOnly: only.has(id) }));
  if (who) throw await notForThem(ctx, actor, companyId, work, who);
}

const notAllowed = () => refuse(403, 'urgent_not_allowed', 'Only the CEO, the CEO delegate or the department\'s owner says that work is urgent, by themselves or through the orchestrator. Nothing was changed.');

/* The orchestrator acts for the CEO and for a department's owner: its tools check that the turn answers them. */
async function maySayUrgent(db: Db | Tx, companyId: string, actor: Actor, departmentId: string | null): Promise<boolean> {
  if (actor.agentId !== undefined) {
    const [agent] = await db.select(only(agents, 'kind')).from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
    return agent?.kind === 'orchestrator';
  }
  const [person] = await db.select().from(people).where(and(eq(people.id, actor.personId), eq(people.companyId, companyId)));
  return Boolean(person && (await runsDepartment(db, person, departmentId)));
}

/* A new task with nothing above it is urgent when someone who may says so; under a task it is what that task is. */
export async function urgencyOfNew(db: Db | Tx, companyId: string, actor: Actor, parent: Pick<Task, 'urgent'> | null, asked: boolean | undefined, departmentId: string | null): Promise<boolean> {
  if (parent) return parent.urgent;
  if (asked && !(await maySayUrgent(db, companyId, actor, departmentId))) throw notAllowed();
  return asked === true;
}

/* All that is under a task goes with it, closed work too: a tree has one urgency. Tasks are made one at a time in a company,
   so with the company held none comes up under it meanwhile. Nobody is woken, as it changes nothing of the work. */
export async function setUrgent(ctx: Pick<Ctx, 'db' | 'bus'>, actor: Actor, taskId: string, urgent: boolean): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  if (!(await maySayUrgent(ctx.db, task.companyId, actor, task.departmentId))) throw notAllowed();
  if (task.parentId) throw refuse(409, 'urgent_follows_parent', `#${task.number} is as urgent as the task above it. Change the top of its tree.`);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} is closed.`);
  const row = await ctx.db.transaction(async tx => {
    await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, task.companyId)).for('no key update');
    await tx.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT id FROM tasks WHERE id = ${task.id}
        UNION ALL
        SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id
      )
      UPDATE tasks SET urgent = ${urgent}, updated_at = now() WHERE id IN (SELECT id FROM tree)`);
    const [changed] = await tx.select().from(tasks).where(eq(tasks.id, task.id));
    await note(tx, changed!, { kind: 'updated', actor, data: { fields: ['urgent'], urgent } });
    return changed!;
  });
  published(ctx, row);
  return { task: row, wakes: [] };
}
