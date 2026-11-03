import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import type { Person } from '../../auth/session.js';
import { agents, departments, jobs, subscriptions, tasks } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';

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
  return rows.sort((a, b) => Number(b.agent.kind === 'orchestrator') - Number(a.agent.kind === 'orchestrator')).map(({ agent: a, department: d, subscription: s }) => {
    const current = work.find(w => w.job.agentId === a.id);
    const task = current?.task;
    const visible = canReach(reach, { departmentId: a.departmentId, parentId: d?.parentId, teamId: a.teamId });
    return {
      subscriptionId: s.id,
      nodeId: a.nodeId,
      builtin: s.kind === 'api_key',
      view: {
        id: a.id, name: a.name, busy: Boolean(current),
        title: (a.roleKey && templates.roles.get(a.roleKey)?.title) || null,
        department: d ? { id: d.id, name: deptName(d) } : null,
        provider: s.provider,
        since: current?.job.startedAt ?? null,
        task: task && visible ? { number: task.number, title: task.title } : null,
        withCeo: current?.job.answersCeo ?? false,
      },
    };
  });
}
