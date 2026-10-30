import { and, asc, eq, isNotNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { personColumns, requirePerson } from '../../auth/session.js';
import { agents, companies, departments, jobs, people, teams } from '../../db/schema.js';
import { deptName } from '../departments/templates.js';
import { workingCount } from '../events/store.js';
import { personViews } from '../people/views.js';
import { identityOf } from '../nodes/hub.js';
import { subView } from '../subscriptions/views.js';

export function orgRoutes(app: FastifyInstance, { db, hub }: Ctx): void {
  app.get('/api/org', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
    const allAgents = await db.select().from(agents);
    const orchestrator = allAgents.find(a => a.kind === 'orchestrator');
    const leaders = await db
      .select(personColumns)
      .from(people)
      .where(and(eq(people.scopeKind, 'company'), ne(people.status, 'disabled')))
      .orderBy(asc(people.createdAt));
    const depts = await db.select().from(departments).orderBy(asc(departments.position), asc(departments.createdAt));
    const allTeams = await db.select().from(teams).orderBy(asc(teams.stage), asc(teams.createdAt));
    const busy = new Set(
      (await db.select({ agentId: jobs.agentId }).from(jobs).where(and(eq(jobs.companyId, me.companyId), eq(jobs.status, 'running'), isNotNull(jobs.agentId)))).map(j => j.agentId),
    );
    /* A department's agents include those in its products. */
    const agentsOf = (deptId: string) => {
      const ids = new Set([deptId, ...depts.filter(p => p.parentId === deptId).map(p => p.id)]);
      const mine = allAgents.filter(a => a.departmentId && ids.has(a.departmentId));
      return { total: mine.length, working: mine.filter(a => busy.has(a.id)).length };
    };

    return {
      company,
      orchestrator: orchestrator && {
        id: orchestrator.id,
        name: orchestrator.name,
        model: orchestrator.model,
        subscription: orchestrator.subscriptionId ? await subView(db, s => hub.isOnline(identityOf(s)), orchestrator.subscriptionId) : null,
      },
      agents: { total: allAgents.length, working: await workingCount(db, me.companyId) },
      people: await personViews(db, leaders),
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
          products: depts.filter(p => p.parentId === d.id).map(p => ({ id: p.id, name: deptName(p) })),
          teams: allTeams
            .filter(t => t.departmentId === d.id)
            .map(t => ({ id: t.id, name: t.name, about: t.about, stage: t.stage, gate: t.gate })),
        })),
    };
  });
}
