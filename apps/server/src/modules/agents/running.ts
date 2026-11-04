import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach, type Access } from '../../auth/access.js';
import type { Person } from '../../auth/session.js';
import { agents, departments, jobs, subscriptions, tasks } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { taskSpot } from '../tasks/engine.js';

async function canOpenAgent(ctx: Ctx, reach: Access, agent: typeof agents.$inferSelect): Promise<boolean> {
  return agent.kind === 'orchestrator' ? reach.whole : canReach(reach, await agentSpot(ctx.db, agent));
}

function currentWork(current: { job: typeof jobs.$inferSelect; task: typeof tasks.$inferSelect | null } | undefined, reach: Access) {
  const task = current?.task;
  return {
    busy: Boolean(current),
    since: current?.job.startedAt ?? null,
    task: task && canReach(reach, taskSpot(task)) ? { number: task.number, title: task.title } : null,
    withCeo: current?.job.answersCeo ?? false,
  };
}

/* Both lists describe the same employees. Placement stays private to their callers, outside the public view. */
export async function runningAgents(ctx: Ctx, viewer: Person) {
  const { db, templates } = ctx;
  const reach = await accessOf(db, viewer);
  const rows = await db.select({ agent: agents, department: departments, subscription: subscriptions })
    .from(agents)
    .innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId))
    .leftJoin(departments, eq(departments.id, agents.departmentId))
    .where(and(eq(agents.companyId, viewer.companyId), isNull(agents.removedAt), isNull(subscriptions.removedAt)))
    .orderBy(asc(departments.position), asc(departments.createdAt), asc(agents.name), asc(agents.id));
  const work = await db.select({ job: jobs, task: tasks }).from(jobs)
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(jobs.companyId, viewer.companyId), eq(jobs.status, 'running')))
    .orderBy(desc(jobs.startedAt), desc(jobs.createdAt));
  return Promise.all(rows.sort((a, b) => Number(b.agent.kind === 'orchestrator') - Number(a.agent.kind === 'orchestrator')).map(async ({ agent: a, department: d, subscription: s }) => {
    const current = work.find(w => w.job.agentId === a.id);
    return {
      subscriptionId: s.id,
      nodeId: a.nodeId,
      builtin: s.kind === 'api_key',
      view: {
        id: a.id, name: a.name, canOpen: await canOpenAgent(ctx, reach, a),
        title: (a.roleKey && templates.roles.get(a.roleKey)?.title) || null,
        department: d ? { id: d.id, name: deptName(d) } : null,
        provider: s.provider,
        ...currentWork(current, reach),
      },
    };
  }));
}
