import { modelsFor } from '@hornhoof/protocol';
import { and, asc, desc, eq, isNotNull, isNull, ne, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { accessOf, canReach } from '../../auth/access.js';
import { personColumns, requirePerson } from '../../auth/session.js';
import { agents, companies, departments, jobs, people, personAccess, subscriptions, tasks, teams, turns } from '../../db/schema.js';
import { employeeOrder } from '../agents/order.js';
import { authorOf } from '../departments/repository.js';
import { deptName } from '../departments/templates.js';
import { workingCount } from '../events/store.js';
import { personViews } from '../people/views.js';
import { identityOf } from '../nodes/hub.js';
import { subView } from '../subscriptions/views.js';

export function orgRoutes(app: FastifyInstance, { db, hub, templates }: Ctx): void {
  app.get('/api/org', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
    const allAgents = await db.select().from(agents).where(isNull(agents.removedAt));
    const subs = new Map((await db.select({ id: subscriptions.id, provider: subscriptions.provider, models: subscriptions.models }).from(subscriptions)).map(s => [s.id, s]));
    const orchestrator = allAgents.find(a => a.kind === 'orchestrator');
    const active = await db.select(personColumns).from(people).where(ne(people.status, 'disabled')).orderBy(asc(people.createdAt));
    const depts = await db.select().from(departments).orderBy(asc(departments.position), asc(departments.createdAt));
    /* What each department works on now: its newest open task without an executor (the head's), else its newest open one.
       Only for people who reach the department; the rest see that it exists, not what it does. */
    const reach = await accessOf(db, me);
    const openTasks = await db
      .select({ id: tasks.id, number: tasks.number, title: tasks.title, departmentId: tasks.departmentId, executor: tasks.executorAgentId })
      .from(tasks)
      .where(and(eq(tasks.companyId, me.companyId), notInArray(tasks.status, ['done', 'cancelled'])))
      .orderBy(desc(tasks.number));
    const currentOf = (id: string) => {
      if (!canReach(reach, { departmentId: id })) return null;
      const mine = openTasks.filter(t => t.departmentId === id);
      const t = mine.find(x => !x.executor) ?? mine[0];
      return t ? { id: t.id, number: t.number, title: t.title } : null;
    };
    /* Only people who see the whole company set repositories, so only they read where they are. */
    const repositoryOf = (d: (typeof depts)[number]) => (reach.whole && d.repoUrl ? { url: d.repoUrl, branch: d.repoBranch ?? 'main', tokenLast4: d.repoTokenLast4, author: authorOf(d) } : null);
    const [turn] = await db.select({ id: turns.id, number: turns.number, goal: turns.goal }).from(turns).where(and(eq(turns.companyId, me.companyId), eq(turns.status, 'open')));
    const allTeams = await db.select().from(teams).orderBy(asc(teams.stage), asc(teams.createdAt));
    /* A listed person counts each place as its top-level department: a product as the department holding it, a team as its department. */
    const topOf = (deptId: string | undefined) => {
      const d = depts.find(x => x.id === deptId);
      return d?.parentId ?? d?.id;
    };
    const access = await db.select().from(personAccess);
    const homes = new Map(
      active.map(p => [p.id, new Set(access.filter(a => a.personId === p.id).map(a => topOf(a.departmentId ?? allTeams.find(t => t.id === a.teamId)?.departmentId)))]),
    );
    /* People who see the whole company or more than one department sit next to the CEO; the rest in their department. */
    const nextToCeo = active.filter(p => p.scopeKind === 'company' || homes.get(p.id)!.size > 1);
    const views = new Map((await personViews(db, active)).map(v => [v.id, v]));
    const inDepartment = (deptId: string) => active.filter(p => p.scopeKind !== 'company' && homes.get(p.id)!.size === 1 && homes.get(p.id)!.has(deptId)).map(p => views.get(p.id)!);
    const busy = new Set(
      (await db.select({ agentId: jobs.agentId }).from(jobs).where(and(eq(jobs.companyId, me.companyId), eq(jobs.status, 'running'), isNotNull(jobs.agentId)))).map(j => j.agentId),
    );
    /* A department's agents include those in its products. */
    const agentsOf = (deptId: string) => {
      const ids = new Set([deptId, ...depts.filter(p => p.parentId === deptId).map(p => p.id)]);
      const mine = allAgents.filter(a => a.departmentId && ids.has(a.departmentId));
      return { total: mine.length, working: mine.filter(a => busy.has(a.id)).length };
    };
    const employeesOf = (dept: (typeof depts)[number]) =>
      allAgents
        .filter(a => a.departmentId === dept.id && a.kind !== 'orchestrator')
        .sort(employeeOrder(templates, dept.templateKey))
        .map(a => {
          const sub = a.subscriptionId ? subs.get(a.subscriptionId) : undefined;
          return {
            id: a.id,
            name: a.name,
            roleId: a.roleKey,
            title: (a.roleKey && templates.roles.get(a.roleKey)?.title) || null,
            kind: a.kind,
            model: a.model,
            modelName: (a.model && sub && modelsFor(sub.provider, sub.models).find(m => m.id === a.model)?.name) || null,
            provider: sub?.provider ?? null,
            state: busy.has(a.id) ? 'working' : a.subscriptionId ? 'sleeping' : 'needs_subscription',
          };
        });

    return {
      company,
      orchestrator: orchestrator && {
        id: orchestrator.id,
        name: orchestrator.name,
        model: orchestrator.model,
        subscription: orchestrator.subscriptionId ? await subView(db, s => hub.isOnline(identityOf(s)), orchestrator.subscriptionId) : null,
      },
      agents: { total: allAgents.length, working: await workingCount(db, me.companyId) },
      turn: turn ?? null,
      people: nextToCeo.map(p => ({ ...views.get(p.id)!, deputy: p.scopeKind !== 'company' })),
      /* Products are departments inside a department; the map shows only the top level and lists the products on it. */
      departments: depts
        .filter(d => !d.parentId)
        .map(d => ({
          id: d.id,
          name: d.name,
          templateKey: d.templateKey,
          roleCode: d.roleCode,
          about: d.about,
          agents: agentsOf(d.id),
          people: inDepartment(d.id),
          employees: employeesOf(d),
          products: depts.filter(p => p.parentId === d.id).map(p => ({ id: p.id, name: deptName(p), repository: repositoryOf(p) })),
          current: currentOf(d.id),
          repository: repositoryOf(d),
          teams: allTeams
            .filter(t => t.departmentId === d.id)
            .map(t => ({ id: t.id, name: t.name, about: t.about, stage: t.stage, gate: t.gate })),
        })),
    };
  });
}
