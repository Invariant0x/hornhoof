import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canReach, type Access } from '../../auth/access.js';
import { seesAgentId, viewerOf } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import { agents, departments, jobs, people, subscriptions, tasks } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { taskSpot } from '../tasks/state.js';
import { notStep } from '../tools/steps.js';

/* startedByCeo: null for a turn no person started. One the CEO delegate started answers the delegate, not the CEO. */
function currentWork(current: { job: typeof jobs.$inferSelect; task: typeof tasks.$inferSelect | null; startedByCeo: boolean | null } | undefined, reach: Access) {
  const task = current?.task;
  return {
    busy: Boolean(current),
    since: current?.job.startedAt ?? null,
    task: task && canReach(reach, taskSpot(task)) ? { number: task.number, title: task.title } : null,
    withCeo: Boolean(current?.job.answersCeo && current.startedByCeo !== false),
  };
}

/* Both lists describe the same employees, those this person sees. Placement stays private to their callers, outside the
   public view. */
export async function runningAgents(ctx: Ctx, viewer: Person) {
  const { db, templates } = ctx;
  const sight = await viewerOf(db, viewer);
  const reach = sight.access;
  const rows = await db.select({ agent: agents, department: departments, subscription: subscriptions })
    .from(agents)
    .innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .leftJoin(departments, eq(departments.id, agents.departmentId))
    .where(and(eq(agents.companyId, viewer.companyId), isNull(agents.removedAt), isNull(subscriptions.removedAt)))
    .orderBy(asc(departments.position), asc(departments.createdAt), asc(agents.name), asc(agents.id));
  const work = await db.select({ job: jobs, task: tasks, startedByCeo: people.isOwner }).from(jobs)
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .leftJoin(people, eq(people.id, jobs.createdBy))
    .where(and(eq(jobs.companyId, viewer.companyId), eq(jobs.status, 'running'), notStep))
    .orderBy(desc(jobs.startedAt), desc(jobs.createdAt));
  return rows.filter(r => seesAgentId(sight, r.agent.id)).sort((a, b) => Number(b.agent.kind === 'orchestrator') - Number(a.agent.kind === 'orchestrator')).map(({ agent: a, department: d, subscription: s }) => {
    const current = work.find(w => w.job.agentId === a.id);
    return {
      subscriptionId: s.id,
      nodeId: a.nodeId,
      builtin: s.kind === 'api_key',
      /* The machine of the built-in node its program is on; none before its first turn, or from before those were told
         apart, when it is the server's own. */
      builtinMachine: a.builtinMachine,
      view: {
        id: a.id, name: a.name, canOpen: true,
        title: (a.roleKey && templates.roles.get(a.roleKey)?.title) || null,
        department: d ? { id: d.id, name: deptName(d) } : null,
        provider: s.provider,
        ...currentWork(current, reach),
      },
    };
  });
}
