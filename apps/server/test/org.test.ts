import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, people, teams } from '../src/db/schema.js';
import { SETUP, TEST_API_KEY, setUpCompany, testApp } from './helpers.js';

const as = (token: string) => ({ cookies: { hh_session: token } });

function addSubscription(app: FastifyInstance, token: string, payload: object) {
  return app.inject({ method: 'POST', url: '/api/subscriptions', payload, ...as(token) });
}

describe('GET /api/org', () => {
  it('shows the chief with its active API key subscription', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await app.inject({ url: '/api/org', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const org = res.json();
    expect(org.company.name).toBe('Acme');
    expect(org.chief).toMatchObject({
      name: 'Chief',
      model: 'claude-opus-5-5',
      subscription: { provider: 'anthropic_api', kind: 'api_key', status: 'ready', last4: '9f3a', owner: { name: 'Ivan' }, target: { kind: 'chief', id: null, name: 'Chief' } },
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

  it('shows no subscription when the chief waits for one', async () => {
    const { app } = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, chief: { mode: 'later' } } });
    const org = (await app.inject({ url: '/api/org', cookies: { hh_session: res.cookies[0]!.value } })).json();
    expect(org.chief.subscription).toBeNull();
  });
});

describe('subscriptions', () => {
  it('never returns the key or its ciphertext', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    await addSubscription(app, ceo, { provider: 'openai_api', kind: 'api_key', label: 'Company OpenAI', apiKey: 'sk-proj-another-key-7777', target: { kind: 'any' } });
    for (const url of ['/api/org', '/api/subscriptions']) {
      const body = (await app.inject({ url, ...as(ceo) })).body;
      expect(body).not.toContain(TEST_API_KEY);
      expect(body).not.toContain('sk-proj-another-key');
      expect(body).not.toContain('secretEnc');
      expect(body).not.toContain('v1.');
    }
    const list = (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json();
    expect(list.subscriptions.map((s: { label: string; target: { name: string } }) => [s.label, s.target.name])).toEqual([
      ['Chief', 'Chief'],
      ['Company OpenAI', 'Any department'],
    ]);
  });

  it('takes only API keys, personal subscriptions connect through a machine', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await addSubscription(app, ceo, { provider: 'claude', kind: 'personal', label: 'Ivan Max', target: { kind: 'chief' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation');
  });

  it('refuses a provider that does not match the kind and a target that does not exist', async () => {
    const { app } = await testApp();
    const ceo = await setUpCompany(app);
    const wrongKind = await addSubscription(app, ceo, { provider: 'claude', kind: 'api_key', label: 'x', apiKey: 'sk-ant-12345678', target: { kind: 'any' } });
    expect(wrongKind.statusCode).toBe(400);
    const noTeam = await addSubscription(app, ceo, { provider: 'anthropic_api', kind: 'api_key', label: 'x', apiKey: 'sk-ant-12345678', target: { kind: 'team', id: '00000000-0000-4000-8000-000000000000' } });
    expect(noTeam.json().error.reason).toBe('unknown_place');
    expect(noTeam.statusCode).toBe(400);
  });

  it('connects a chief that waited for a subscription', async () => {
    const { app, db } = await testApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, chief: { mode: 'later' } } });
    const ceo = setup.cookies[0]!.value;
    const res = await addSubscription(app, ceo, { provider: 'anthropic_api', kind: 'api_key', label: 'Chief key', apiKey: 'sk-ant-api03-late-key-1234', target: { kind: 'chief' } });
    expect(res.statusCode).toBe(201);
    const [chief] = await db.select().from(agents);
    expect(chief!.subscriptionId).toBe(res.json().subscription.id);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.chief.subscription).toMatchObject({ label: 'Chief key', last4: '1234' });
  });
});
