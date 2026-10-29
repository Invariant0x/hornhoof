import { describe, expect, it } from 'vitest';
import { companies, departments, people, teams } from '../src/db/schema.js';
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
