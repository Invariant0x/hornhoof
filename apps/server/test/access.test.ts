import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { canReach, type Access } from '../src/auth/access.js';
import { agents, companies, departments, people, personAccess, teams } from '../src/db/schema.js';
import { appendEvent } from '../src/modules/events/store.js';
import { as, invitePerson, listen, openStream, ownPlan, setUpCompany, testApp, until } from './helpers.js';

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  /* Departments come in their order on the company's map, as the build gives each new one the next position; two made at once share
     their creation time on a coarse clock, so the time alone orders nothing. */
  const createdAt = new Date('2026-11-09T00:00:00.000Z');
  const [sales] = await db.insert(departments).values({ companyId, name: 'Sales', roleCode: 'SAL', position: 100, createdAt }).returning();
  const [marketing] = await db.insert(departments).values({ companyId, name: 'Marketing', roleCode: 'CMO', position: 101, createdAt }).returning();
  const [social] = await db.insert(teams).values({ companyId, departmentId: marketing!.id, name: 'Social' }).returning();
  return { app, db, ceo, companyId, sales: sales!, marketing: marketing!, social: social! };
}

const invite = (app: Awaited<ReturnType<typeof company>>['app'], ceo: string, payload: object) =>
  app.inject({ method: 'POST', url: '/api/people/invite', payload: { name: 'Maria', email: 'maria@acme.com', title: '', ...payload }, ...as(ceo) });

describe('canReach', () => {
  const listed = (departments: string[], teams: string[] = []): Access => ({ whole: false, departments: new Set(departments), teams: new Set(teams) });

  it('reaches a listed department, the products inside it and a listed team, and nothing else', () => {
    expect(canReach({ whole: true, departments: new Set(), teams: new Set() }, { departmentId: null })).toBe(true);
    const sales = listed(['sales'], ['social']);
    expect(canReach(sales, { departmentId: 'sales' })).toBe(true);
    expect(canReach(sales, { departmentId: 'mascot', parentId: 'sales' })).toBe(true);
    expect(canReach(sales, { departmentId: 'marketing', teamId: 'social' })).toBe(true);
    expect(canReach(sales, { departmentId: 'marketing' })).toBe(false);
    expect(canReach(sales, { departmentId: null })).toBe(false);
  });

  it('does not reach a product of another department', () => {
    expect(canReach(listed(['sales']), { departmentId: 'website', parentId: 'marketing' })).toBe(false);
  });

  it('does not reach a team that is not listed', () => {
    expect(canReach(listed(['sales'], ['social']), { departmentId: 'marketing', teamId: 'ads' })).toBe(false);
  });
});

describe('access by departments', () => {
  it('invites a person to two departments', async () => {
    const { app, db, ceo, sales, marketing } = await company();
    const res = await invite(app, ceo, { access: { departments: [sales.id, marketing.id] } });
    expect(res.statusCode).toBe(201);
    expect(res.json().person.access).toEqual({
      whole: false,
      departments: [
        { id: sales.id, name: 'Sales' },
        { id: marketing.id, name: 'Marketing' },
      ],
      teams: [],
    });
    const [maria] = await db.select().from(people).where(eq(people.email, 'maria@acme.com'));
    expect(maria!.scopeKind).toBe('listed');
    expect(await db.select().from(personAccess).where(eq(personAccess.personId, maria!.id))).toHaveLength(2);
  });

  it('changes a person from the whole company to a list and back', async () => {
    const { app, db, ceo, marketing, social } = await company();
    const id = (await invite(app, ceo, { access: { whole: true } })).json().person.id;
    const listed = await app.inject({ method: 'PATCH', url: `/api/people/${id}`, payload: { access: { departments: [marketing.id], teams: [social.id] } }, ...as(ceo) });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().person.access).toEqual({
      whole: false,
      departments: [{ id: marketing.id, name: 'Marketing' }],
      teams: [{ id: social.id, name: 'Social', departmentId: marketing.id }],
    });
    const back = await app.inject({ method: 'PATCH', url: `/api/people/${id}`, payload: { access: { whole: true } }, ...as(ceo) });
    expect(back.json().person.access).toEqual({ whole: true, departments: [], teams: [] });
    expect(await db.select().from(personAccess).where(eq(personAccess.personId, id))).toHaveLength(0);
  });

  it('refuses an empty list', async () => {
    const { app, ceo } = await company();
    for (const access of [{ departments: [], teams: [] }, {}]) {
      const res = await invite(app, ceo, { access });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation');
    }
  });

  it('refuses to remove a department people are listed in', async () => {
    const { app, ceo, sales, marketing } = await company();
    await invite(app, ceo, { access: { departments: [sales.id, marketing.id] } });
    const refused = await app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ department: marketing.id, note: '', remove: true }] }, ...as(ceo) });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.message).toContain('People work in Marketing');
  });

  it('lets a personal plan serve every department its owner has', async () => {
    const { app, ceo, sales, social } = await company();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id], teams: [social.id] } });
    const res = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(maria) });
    expect(res.statusCode).toBe(201);
    expect(res.json().subscriptions[0].place).toEqual({ kind: 'listed', id: null, name: 'Sales, Marketing' });
  });

  it('puts a person with two departments next to the CEO on the map', async () => {
    const { app, ceo, sales, marketing, social } = await company();
    await invite(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [sales.id, marketing.id] } });
    await invite(app, ceo, { name: 'Elin', email: 'elin@acme.com', access: { departments: [sales.id] } });
    await invite(app, ceo, { name: 'Sasha', email: 'sasha@acme.com', access: { teams: [social.id] } });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.people.map((p: { name: string; deputy: boolean }) => [p.name, p.deputy])).toEqual([
      ['Ivan', false],
      ['Oleg', true],
    ]);
    const byName = Object.fromEntries(org.departments.map((d: { name: string; people: { name: string }[] }) => [d.name, d.people.map(p => p.name)]));
    expect(byName).toEqual({ Sales: ['Elin'], Marketing: ['Sasha'] });
  });

  it("sends a department's live events only to people who reach it and own the agent's plan", async () => {
    const { app, db, ceo, companyId, sales, marketing } = await company();
    await listen(app);
    const [seller] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Seller', model: '', departmentId: sales.id }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales.id] } });
    const elin = await invitePerson(app, ceo, { name: 'Elin', email: 'elin@acme.com', access: { departments: [marketing.id] } });
    await ownPlan(db, 'maria@acme.com', seller!.id);
    /* Each stream listens from the moment it answers: the server takes the bus in the same step it sends the headers. */
    const streams = await Promise.all([ceo, maria, elin].map(t => openStream(app, t)));
    await appendEvent(app.ctx, { companyId, agentId: seller!.id, kind: 'text', data: { text: 'Two schools signed.' } });
    app.ctx.bus.publish(companyId, { type: 'org' });
    await until(() => streams.every(s => s.messages.some(m => m.type === 'org')));
    expect(streams.map(s => s.messages.map(m => m.type))).toEqual([['agent_event', 'org'], ['agent_event', 'org'], ['org']]);
    for (const s of streams) s.close();
  });
});
