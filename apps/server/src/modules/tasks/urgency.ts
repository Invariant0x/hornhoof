import { and, eq, inArray, sql } from 'drizzle-orm';
import { actsAsCeo } from '../../auth/decisions.js';
import type { Db } from '../../db/client.js';
import { agents, companies, people, tasks, teams } from '../../db/schema.js';
import { CLOSED, loadTask, note, published, refuse, type Actor, type Live, type Moved, type Task, type Tx } from './engine.js';

/* Whether work is urgent is data: the CEO says so through the orchestrator or a route, and nothing is read from its words.
   Work under a task is as urgent as it is. A team may take urgent work only, and who is in it says who that holds for. */

/* What the filters that give out work ask. It looks at nothing but these two, and leaves work a holder already has alone. */
export const mayHoldTask = ({ urgent }: Pick<Task, 'urgent'>, { urgentOnly }: { urgentOnly: boolean }): boolean => urgent || !urgentOnly;

/* Those of these agents in a team that takes only urgent work, as they stand now. */
export async function urgentOnlyAgents(db: Db | Tx, companyId: string, agentIds: readonly string[]): Promise<ReadonlySet<string>> {
  if (!agentIds.length) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(teams, and(eq(teams.id, agents.teamId), eq(teams.companyId, companyId)))
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds]), eq(teams.urgentOnly, true)));
  return new Set(rows.map(row => row.id));
}

const notAllowed = () => refuse(403, 'urgent_not_allowed', 'Only the CEO or the CEO delegate says that work is urgent, by themselves or through the orchestrator. Nothing was changed.');

/* The orchestrator acts for the CEO: its tools check that the turn answers them. */
async function maySayUrgent(db: Db | Tx, companyId: string, actor: Actor): Promise<boolean> {
  if (actor.agentId) {
    const [agent] = await db.select({ kind: agents.kind }).from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId)));
    return agent?.kind === 'orchestrator';
  }
  const [person] = await db.select().from(people).where(and(eq(people.id, actor.personId), eq(people.companyId, companyId)));
  return Boolean(person && actsAsCeo(person));
}

/* A new task with nothing above it is urgent when someone who may says so; under a task it is what that task is. */
export async function urgencyOfNew(db: Db | Tx, companyId: string, actor: Actor, parent: Pick<Task, 'urgent'> | null, asked: boolean | undefined): Promise<boolean> {
  if (parent) return parent.urgent;
  if (asked && !(await maySayUrgent(db, companyId, actor))) throw notAllowed();
  return asked === true;
}

/* All that is under a task goes with it, closed work too: a tree has one urgency. Tasks are made one at a time in a company,
   so with the company held none comes up under it meanwhile. Nobody is woken, as it changes nothing of the work. */
export async function setUrgent(ctx: Live, actor: Actor, taskId: string, urgent: boolean): Promise<Moved> {
  const task = await loadTask(ctx.db, taskId);
  if (!(await maySayUrgent(ctx.db, task.companyId, actor))) throw notAllowed();
  if (task.parentId) throw refuse(409, 'urgent_follows_parent', `#${task.number} is as urgent as the task above it. Change the top of its tree.`);
  if (CLOSED.includes(task.status)) throw refuse(409, 'task_invalid', `#${task.number} is closed.`);
  const row = await ctx.db.transaction(async tx => {
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, task.companyId)).for('update');
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
