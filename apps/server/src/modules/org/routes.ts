import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Deps } from '../../app.js';
import { personColumns, requirePerson } from '../../auth/session.js';
import { agents, companies, departments, people, teams } from '../../db/schema.js';
import { personViews } from '../people/views.js';
import { subView } from '../subscriptions/views.js';

export function orgRoutes(app: FastifyInstance, { db }: Deps): void {
  app.get('/api/org', async req => {
    const me = await requirePerson(req, db);
    const [company] = await db.select({ id: companies.id, name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
    const allAgents = await db.select().from(agents);
    const chief = allAgents.find(a => a.kind === 'chief');
    const leaders = await db.select(personColumns).from(people).where(eq(people.scopeKind, 'company')).orderBy(asc(people.createdAt));
    const depts = await db.select().from(departments).orderBy(asc(departments.position), asc(departments.createdAt));
    const allTeams = await db.select().from(teams).orderBy(asc(teams.stage), asc(teams.createdAt));

    return {
      company,
      chief: chief && {
        name: chief.name,
        model: chief.model,
        subscription: chief.subscriptionId ? await subView(db, chief.subscriptionId) : null,
      },
      /* Nothing runs agents until nodes arrive in milestone 2, so none are working yet. */
      agents: { total: allAgents.length, working: 0 },
      people: await personViews(db, leaders),
      departments: depts.map(d => ({
        id: d.id,
        name: d.name,
        roleCode: d.roleCode,
        teams: allTeams
          .filter(t => t.departmentId === d.id)
          .map(t => ({ id: t.id, name: t.name, about: t.about, stage: t.stage, gate: t.gate })),
      })),
    };
  });
}
