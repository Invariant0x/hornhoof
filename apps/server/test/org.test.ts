import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, people, subscriptions, teams } from '../src/db/schema.js';
import { as, SETUP, setUpCompany, testApp } from './helpers.js';

describe('GET /api/org', () => {
  it('shows the orchestrator with its active API key subscription', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await app.inject({ url: '/api/org', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const org = res.json();
    expect(org.company.name).toBe('Acme');
    expect(org.orchestrator).toMatchObject({
      name: 'Orchestrator',
      model: 'claude-opus-5-5',
      subscription: { provider: 'anthropic_api', kind: 'api_key', status: 'ready', online: false, last4: '9f3a', owner: { name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, isOrchestrator: true },
    });
    expect(org.agents).toEqual({ total: 1, working: 0 });
    expect(org.people.map((p: { name: string }) => p.name)).toEqual(['Ivan']);
    expect(org.departments).toEqual([]);
    expect((await app.inject({ url: '/api/org' })).statusCode).toBe(401);
  });

  it('lists departments with their teams in pipeline order', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, name: 'Development', roleCode: 'CTO' }).returning();
    await db.insert(teams).values([
      { companyId: company!.id, departmentId: dev!.id, name: 'QA', stage: 2, gate: true },
      { companyId: company!.id, departmentId: dev!.id, name: 'Backend', about: 'APIs', stage: 0 },
    ]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments).toHaveLength(1);
    expect(org.departments[0]).toMatchObject({ id: dev!.id, name: 'Development', roleCode: 'CTO' });
    expect(org.departments[0].teams.map((t: { name: string }) => t.name)).toEqual(['Backend', 'QA']);
    expect(org.departments[0].teams[1]).toMatchObject({ stage: 2, gate: true, about: '' });
  });

  it('shows template departments by template, with their products inside', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, name: null, templateKey: 'development', roleCode: 'DEV', about: 'Builds both products', position: 0 }).returning();
    await db.insert(departments).values([
      { companyId: company!.id, name: 'Mascot', parentId: dev!.id, roleCode: 'DEV', position: 1 },
      { companyId: company!.id, name: 'Characters', parentId: dev!.id, roleCode: 'DEV', position: 2 },
      { companyId: company!.id, name: 'Sales Europe', templateKey: 'sales', roleCode: 'SAL', position: 3 },
    ]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments).toHaveLength(2);
    expect(org.departments[0]).toMatchObject({ id: dev!.id, name: null, templateKey: 'development', roleCode: 'DEV', about: 'Builds both products' });
    expect(org.departments[0].products.map((p: { name: string }) => p.name)).toEqual(['Mascot', 'Characters']);
    expect(org.departments[1]).toMatchObject({ name: 'Sales Europe', templateKey: 'sales', products: [] });
  });

  it('counts the agents of each department, its products included, and those at work', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, name: 'Development', roleCode: 'DEV', position: 0 }).returning();
    const [app1] = await db.insert(departments).values({ companyId: company!.id, name: 'App', parentId: dev!.id, roleCode: 'DEV', position: 1 }).returning();
    await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'SAL', position: 2 });
    const [, worker] = await db
      .insert(agents)
      .values([
        { companyId: company!.id, kind: 'head', name: 'Atlas', model: 'm', departmentId: dev!.id },
        { companyId: company!.id, kind: 'worker', name: 'App-1', model: 'm', departmentId: app1!.id },
      ])
      .returning();
    await db.insert(jobs).values({ companyId: company!.id, subscriptionId: sub!.id, agentId: worker!.id, prompt: 'build', status: 'running', timeoutMs: 1000 });
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments.map((d: { agents: unknown }) => d.agents)).toEqual([{ total: 2, working: 1 }, { total: 0, working: 0 }]);
  });

  it('names a template department by its template where a subscription serves it', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, name: null, templateKey: 'development', roleCode: 'DEV' }).returning();
    const res = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      payload: { provider: 'openai_api', kind: 'api_key', label: 'Dev key', apiKey: 'sk-proj-dev-key-1234', target: { kind: 'department', id: dev!.id } },
      ...as(ceo),
    });
    expect(res.json().subscription.place).toEqual({ kind: 'department', id: dev!.id, name: 'Development' });
  });

  it('leaves disabled people off the map', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    await db.insert(people).values([
      { companyId: company!.id, name: 'Former deputy', email: 'former@acme.com', status: 'disabled', scopeKind: 'company' },
      { companyId: company!.id, name: 'New deputy', email: 'new@acme.com', status: 'invited', scopeKind: 'company' },
    ]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.people.map((p: { name: string }) => p.name)).toEqual(['Ivan', 'New deputy']);
  });

  it('shows no subscription when the orchestrator waits for one', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'later' } } });
    const org = (await app.inject({ url: '/api/org', cookies: { hh_session: res.cookies[0]!.value } })).json();
    expect(org.orchestrator.subscription).toBeNull();
  });
});
