import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/client.js';
import { agents, companies, departments, people, subscriptions } from '../src/db/schema.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as } from './helpers-basic.js';
import { invitePerson, setUpCompany } from './helpers-company.js';

/* The browser worker owns the app and database itself, without a test runner's lifecycle hooks. */
export async function aclCompanyOn(app: FastifyInstance, db: Db, url: string) {
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [dev, sales] = await db
    .insert(departments)
    .values([
      { companyId, templateKey: 'development', roleCode: 'DEV', position: 1 },
      { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
    ])
    .returning();
  const invite = (name: string, access: Parameters<typeof invitePerson>[2]['access']) => invitePerson(app, ceo, { name, email: `${name.toLowerCase()}@acme.com`, access });
  const tokens = {
    ceo,
    ann: await invite('Ann', { departments: [dev!.id] }),
    bob: await invite('Bob', { departments: [dev!.id] }),
    olga: await invite('Olga', { departments: [dev!.id] }),
    wes: await invite('Wes', { whole: true }),
    lisa: await invite('Lisa', { whole: true }),
  };
  const rows = await db.select().from(people);
  const personId = (name: string) => rows.find(p => p.name === name)!.id;
  const ids = { ceo: rows.find(p => p.isOwner)!.id, ann: personId('Ann'), bob: personId('Bob'), olga: personId('Olga'), wes: personId('Wes'), lisa: personId('Lisa') };
  await app.inject({ method: 'PUT', url: `/api/people/${ids.lisa}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(ceo) });
  await app.inject({ method: 'PUT', url: `/api/departments/${dev!.id}/owner`, payload: { personId: ids.olga }, ...as(ceo) });
  const plan = async (ownerPersonId: string, label: string) =>
    (await db.insert(subscriptions).values({ companyId, provider: 'claude', kind: 'personal', label, status: 'ready', ownerPersonId }).returning())[0]!;
  const plans = { ann: await plan(ids.ann, 'Ann plan'), bob: await plan(ids.bob, 'Bob plan'), olga: await plan(ids.olga, 'Olga plan'), wes: await plan(ids.wes, 'Wes plan'), lisa: await plan(ids.lisa, 'Lisa plan') };
  const hire = async (name: string, kind: 'head' | 'worker', departmentId: string, subscriptionId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey: kind === 'head' ? 'DEV-HEAD' : 'DEV-BE', departmentId, model: '', subscriptionId }).returning())[0]!;
  const crew = {
    /* Own plan, reachable department: Ann's. */
    mine: await hire('Mina', 'worker', dev!.id, plans.ann.id),
    /* Another's plan, reachable department. */
    other: await hire('Otto', 'worker', dev!.id, plans.bob.id),
    /* Own plan, department out of reach. */
    away: await hire('Awa', 'worker', sales!.id, plans.ann.id),
    /* Another's plan, department out of reach. */
    far: await hire('Fara', 'worker', sales!.id, plans.bob.id),
    head: await hire('Hana', 'head', dev!.id, plans.bob.id),
    owned: await hire('Oleg', 'worker', dev!.id, plans.olga.id),
    wide: await hire('Wanda', 'worker', sales!.id, plans.wes.id),
    deputy: await hire('Lena', 'worker', sales!.id, plans.lisa.id),
  };
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  /* Work of one agent, given by the head of Development. */
  const work = async (title: string, agent: { id: string }, departmentId = dev!.id) =>
    (await createTask(app.ctx, { agentId: crew.head.id }, { title, brief: `${title} brief`, body: `${title} body`, departmentId, assigneeAgentId: agent.id, executor: true, gates: [] })).task;
  const get = (url: string, token: string) => app.inject({ url, ...as(token) });
  return { app, db, url, companyId, tokens, ids, plans, crew, orchestrator: orchestrator!, dev: dev!, sales: sales!, work, get };
}

