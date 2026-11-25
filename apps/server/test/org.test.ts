import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, companies, departments, jobs, people, subscriptions, teams } from '../src/db/schema.js';
import { BUILTIN } from './builtin.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { ask, createTask, submit } from '../src/modules/tasks/engine.js';
import { checkSilentTurns, SILENT_TURN_MS } from '../src/modules/tasks/silent.js';
import { keyEndFor, subView } from '../src/modules/subscriptions/views.js';
import { failureCompany } from './failure-company.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import type { EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import { as, echelonsTurn, invitePerson, SETUP, setUpCompany, statements, testApp, ownPlan } from './helpers.js';

describe('GET /api/org', () => {
  it('shows the same turnkey membership on the employee card as on the map', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dept] = await db.insert(departments).values({ companyId: company!.id, name: 'Work', roleCode: 'WORK' }).returning();
    const [team] = await db.insert(teams).values({ companyId: company!.id, departmentId: dept!.id, name: 'Whole tasks', turnkey: true }).returning();
    const [worker] = await db.insert(agents).values({ companyId: company!.id, departmentId: dept!.id, teamId: team!.id, kind: 'worker', name: 'Alex', model: '' }).returning();

    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees).toContainEqual(expect.objectContaining({ id: worker!.id, turnkey: true }));
    const card = await app.inject({ url: `/api/agents/${worker!.id}`, ...as(ceo) });
    expect(card.statusCode).toBe(200);
    expect(card.json()).toMatchObject({ team: { id: team!.id }, turnkey: true });
  });

  it('reads failure state with the same number of queries as the company grows', async () => {
    const c = await failureCompany();
    const seen = statements();
    expect((await c.app.inject({ url: '/api/org', ...as(c.ceo) })).statusCode).toBe(200);
    const before = seen.length;
    await c.db.insert(agents).values(Array.from({ length: 6 }, (_, i) => ({ companyId: c.companyId, name: `Employee ${i}`, kind: 'worker' as const, departmentId: c.dev.id, model: '' })));
    seen.length = 0;
    expect((await c.app.inject({ url: '/api/org', ...as(c.ceo) })).statusCode).toBe(200);
    expect(seen).toHaveLength(before);
  });

  it('gives each agent its own failure and retry chain', async () => {
    const c = await failureCompany();
    const at = new Date();
    const base = { companyId: c.companyId, subscriptionId: c.sub.id, kind: 'conversation' as const, prompt: 'Work', timeoutMs: 900000, status: 'failed' as const, finishedAt: at };
    const [cut, refused, network] = await c.db.insert(jobs).values([
      { ...base, agentId: c.agent.id, failure: { kind: 'cut', text: 'Connection ended.', retryable: true } },
      { ...base, agentId: c.head.id, failure: { kind: 'refused', text: 'Work refused.', retryable: false } },
      { ...base, agentId: c.watcher.id, failure: { kind: 'network', text: 'Offline.', retryable: true } },
    ]).returning();
    const [again] = await c.db.insert(jobs).values({ ...base, agentId: c.watcher.id, failure: network!.failure, continueOf: network!.id }).returning();
    await c.db.insert(jobs).values([
      { ...base, agentId: c.agent.id, status: 'queued', finishedAt: null, continueOf: cut!.id, notBefore: new Date(+at + 60000) },
      { ...base, agentId: c.watcher.id, status: 'queued', finishedAt: null, continueOf: again!.id, notBefore: new Date(+at + 120000) },
    ]);

    const org = (await c.app.inject({ url: '/api/org', ...as(c.ceo) })).json();
    /* An error that retries by itself is no failure while its retry waits; one that does not retry is. */
    const employees = org.departments.flatMap((d: { employees: { id: string }[] }) => d.employees);
    expect(employees.find((a: { id: string }) => a.id === c.agent.id)).toMatchObject({ failure: null, retry: { attempt: 1, max: 4, at: +at + 60000, kind: 'cut' } });
    expect(employees.find((a: { id: string }) => a.id === c.head.id)).toMatchObject({ failure: { kind: 'refused', text: refused!.failure!.text, at: +at }, retry: null });
    expect(employees.find((a: { id: string }) => a.id === c.watcher.id)).toMatchObject({ failure: null, retry: { attempt: 2, max: 4, at: +at + 120000, kind: 'network' } });
    expect(org.orchestrator).toMatchObject({ failure: null, retry: null });
  });

  it('shows only the session company, including its own orchestrator', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [ownOrchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [otherCompany] = await db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
    const [otherPerson] = await db.insert(people).values({ companyId: otherCompany!.id, name: 'Other person', email: 'other@example.test', title: 'Other title', status: 'active', scopeKind: 'company' }).returning();
    const [otherSub] = await db.insert(subscriptions).values({ companyId: otherCompany!.id, ownerPersonId: otherPerson!.id, provider: 'claude', kind: 'personal', label: 'Other plan', status: 'ready' }).returning();
    const [otherDept] = await db.insert(departments).values({ companyId: otherCompany!.id, name: 'Other department', roleCode: 'OTHER' }).returning();
    await db.insert(teams).values({ companyId: otherCompany!.id, departmentId: otherDept!.id, name: 'Other team' });
    await db.delete(agents).where(eq(agents.id, ownOrchestrator!.id));
    await db.insert(agents).values([
      { companyId: otherCompany!.id, name: 'Other orchestrator', kind: 'orchestrator', model: '', subscriptionId: otherSub!.id },
      { companyId: otherCompany!.id, name: 'Other employee', kind: 'worker', departmentId: otherDept!.id, model: '', subscriptionId: otherSub!.id },
      ownOrchestrator!,
    ]);

    const res = await app.inject({ url: '/api/org', ...as(ceo) });

    expect(res.statusCode).toBe(200);
    expect(res.json().company.name).toBe('Acme');
    expect(res.json().orchestrator).toMatchObject({ name: 'Orchestrator', subscription: { label: 'Orchestrator', owner: { name: 'Ivan' } } });
    expect(res.json().agents).toEqual({ total: 1, working: 0 });
    expect(res.json().people.map((p: { name: string }) => p.name)).toEqual(['Ivan']);
    expect(res.json().departments).toEqual([]);
    for (const secret of ['Other person', 'Other title', 'other@example.test', 'Other plan', 'Other orchestrator', 'Other employee', 'Other department', 'Other team']) {
      expect(res.body).not.toContain(secret);
    }
  });

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

  it('gives the end of the orchestrator\'s key only to people who see the whole company or own its plan', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', position: 1 }).returning();
    const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [dev!.id] } });
    expect((await app.inject({ url: '/api/org', ...as(ceo) })).json().orchestrator.subscription.last4).toBe('9f3a');
    expect((await app.inject({ url: '/api/org', ...as(ann) })).body).not.toContain('9f3a');
    /* Whoever the plan reaches, the same rule as on an employee's card. */
    const [plan] = await db.select().from(subscriptions);
    const view = (await subView(db, () => false, plan!.id))!;
    const [owner] = await db.select().from(people).where(eq(people.id, plan!.ownerPersonId));
    expect(keyEndFor({ id: 'someone', scopeKind: 'listed' }, view).last4).toBeNull();
    expect(keyEndFor({ id: 'someone', scopeKind: 'company' }, view).last4).toBe('9f3a');
    expect(keyEndFor({ id: owner!.id, scopeKind: 'listed' }, view).last4).toBe('9f3a');
  });

  it("says until when the orchestrator's plan is at its limit, and nothing once it is not", async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    expect((await app.inject({ url: '/api/org', ...as(ceo) })).json().orchestrator.limitUntil).toBeNull();
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    await db.update(subscriptions).set({ limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt }] }, limitsUpdatedAt: new Date() });
    expect((await app.inject({ url: '/api/org', ...as(ceo) })).json().orchestrator.limitUntil).toBe(resetsAt);
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

  it('tells what each employee does now, to everyone of the company', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const companyId = company!.id;
    const [dev, sales] = await db
      .insert(departments)
      .values([
        { companyId, templateKey: 'development', roleCode: 'DEV', position: 0 },
        { companyId, templateKey: 'sales', roleCode: 'SAL', position: 1 },
      ])
      .returning();
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, subscriptionId: string | null = sub!.id) =>
      (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [] }).returning())[0]!;
    const hana = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const felix = await hire('Felix', 'worker', 'DEV-FE');
    const rita = await hire('Rita', 'worker', 'DEV-REV');
    const quinn = await hire('Quinn', 'worker', 'DEV-QA');
    await hire('Ida', 'worker', 'DEV-OPS');
    await hire('Otto', 'worker', 'DEV-TEST', null);
    const ctx = app.ctx;
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev!.id));
    ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
    ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
    await echelonsTurn(db, companyId);
    const [ceoRow] = await db.select().from(people);
    const top = (await createTask(ctx, { personId: ceoRow!.id }, { title: 'Payments', brief: '', body: '', departmentId: dev!.id, assigneeAgentId: hana.id })).task;
    const member = async (title: string, agentId: string, reviewerAgentId = rita.id) =>
      (await createTask(ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, parentId: top.id, assigneeAgentId: agentId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
    const api = await member('Checkout API', bruno.id);
    const page = await member('Checkout page', felix.id, rita.id);
    const accept = await member('Acceptance', quinn.id);
    await submit(ctx, felix.id, page.id, { summary: 'Done', evidence: 'npm test', review: { baseCommit: BASE } });
    await ask(ctx, quinn.id, accept.id, { kind: 'question', text: 'Which cards?' });
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: bruno.id, taskId: api.id, prompt: 'build', status: 'running', timeoutMs: 1000 });

    const doing = (org: { departments: { id: string; employees: { name: string; status: string; task: { number: number; echelons: EchelonsSnapshot } | null }[] }[] }) =>
      Object.fromEntries(org.departments.find(d => d.id === dev!.id)!.employees.map(e => [e.name, [e.status, e.task && e.task.number]]));
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(doing(org)).toEqual({
      Hana: ['handed', top.number],
      Bruno: ['working', api.number],
      Felix: ['handed', page.number],
      Rita: ['queued', page.number],
      Quinn: ['waiting', accept.number],
      Ida: ['idle', null],
      Otto: ['off', null],
    });
    const felixLine = org.departments.find((d: { id: string }) => d.id === dev!.id).employees.find((e: { name: string }) => e.name === 'Felix');
    expect(felixLine.task).toMatchObject({ id: page.id, title: 'Checkout page', echelons: { stage: 'review', phase: 'active', ownerAgentId: rita.id, candidateId: expect.any(String) } });
    const roles = org.departments.find((d: { id: string }) => d.id === dev!.id).roles;
    expect(roles.find((r: { id: string }) => r.id === 'DEV-REV')).toMatchObject({ gate: 1, title: { en: 'Code reviewer' } });
    expect(roles.find((r: { id: string }) => r.id === 'DEV-BE')).toMatchObject({ gate: null });

    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
    const hers = (await app.inject({ url: '/api/org', ...as(maria) })).json();
    expect(doing(hers)).toEqual(doing(org));
  });

  it('shows independent Review owners while one waits for a person', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', position: 0, repoUrl: 'https://github.com/acme/shop.git' }).returning();
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId: company!.id, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [] }).returning())[0]!;
    const hana = await hire('Hana', 'head', 'DEV-HEAD');
    const felix = await hire('Felix', 'worker', 'DEV-FE');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const rita = await hire('Rita', 'worker', 'DEV-REV');
    const rex = await hire('Rex', 'worker', 'DEV-REV');
    app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
    app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
    const create = async (title: string, assigneeAgentId: string, reviewerAgentId: string) => (await createTask(app.ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, assigneeAgentId, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
    await echelonsTurn(db, company!.id);
    const page = await create('Checkout page', felix.id, rita.id);
    const api = await create('Checkout API', bruno.id, rex.id);
    await submit(app.ctx, felix.id, page.id, { summary: 'Page candidate', evidence: 'Changed page tests.', review: { baseCommit: BASE } });
    await submit(app.ctx, bruno.id, api.id, { summary: 'API candidate', evidence: 'Changed API tests.', review: { baseCommit: BASE } });
    await ask(app.ctx, rita.id, page.id, { kind: 'question', text: 'Which browsers?' });
    const response = await app.inject({ url: '/api/org', ...as(ceo) });
    expect(response.statusCode).toBe(200);
    const org = response.json();
    const doing = Object.fromEntries(org.departments[0].employees.map((e: { name: string; status: string; task: { number: number } | null }) => [e.name, [e.status, e.task?.number ?? null]]));
    expect(doing).toMatchObject({ Rita: ['waiting', page.number], Rex: ['queued', api.number] });
  });

  it('shows nobody at a task that still waits for the tasks it comes after', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV', position: 0 }).returning();
    const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
      (await db.insert(agents).values({ companyId: company!.id, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
    const hana = await hire('Hana', 'head', 'DEV-HEAD');
    const bruno = await hire('Bruno', 'worker', 'DEV-BE');
    const ida = await hire('Ida', 'worker', 'DEV-OPS');
    const member = async (title: string, agentId: string, after: string[] = []) =>
      (await createTask(app.ctx, { agentId: hana.id }, { title, brief: '', body: '', departmentId: dev!.id, assigneeAgentId: agentId, executor: true, after, ...(after.length ? { independentNone: 'Deployment starts after the API is complete.' } : {}) })).task;
    const api = await member('Checkout API', bruno.id);
    await member('Deploy', ida.id, [api.id]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    const doing = Object.fromEntries(org.departments[0].employees.map((e: { name: string; status: string; task: { number: number } | null }) => [e.name, [e.status, e.task?.number ?? null]]));
    expect(doing).toMatchObject({ Bruno: ['queued', api.number], Ida: ['idle', null] });
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

  it('gives each deputy the top-level department ids they reach, products and teams included', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const companyId = company!.id;
    const [dev, sales, support] = await db
      .insert(departments)
      .values([
        { companyId, name: 'Development', roleCode: 'DEV', position: 0 },
        { companyId, name: 'Sales', roleCode: 'SAL', position: 1 },
        { companyId, name: 'Support', roleCode: 'SUP', position: 2 },
      ])
      .returning();
    const [mascot] = await db.insert(departments).values({ companyId, name: 'Mascot', parentId: dev!.id, roleCode: 'DEV', position: 3 }).returning();
    const [inbound] = await db.insert(teams).values({ companyId, departmentId: sales!.id, name: 'Inbound', stage: 0 }).returning();

    await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [sales!.id, support!.id] } });
    await invitePerson(app, ceo, { name: 'Mira', email: 'mira@acme.com', access: { departments: [mascot!.id], teams: [inbound!.id] } });
    await invitePerson(app, ceo, { name: 'Elin', email: 'elin@acme.com', access: { departments: [mascot!.id] } });

    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    const byName = Object.fromEntries(org.people.map((p: { name: string; deputy: boolean; departments?: string[] }) => [p.name, { deputy: p.deputy, departments: p.departments }]));
    expect(byName).toEqual({
      Ivan: { deputy: false, departments: undefined },
      Oleg: { deputy: true, departments: [sales!.id, support!.id] },
      Mira: { deputy: true, departments: [dev!.id, sales!.id] },
    });
    const mira = org.people.find((p: { name: string }) => p.name === 'Mira');
    expect(mira.access).toEqual({
      whole: false,
      departments: [{ id: mascot!.id, name: 'Mascot' }],
      teams: [{ id: inbound!.id, name: 'Inbound', departmentId: sales!.id }],
    });
    expect(org.departments.find((d: { id: string }) => d.id === dev!.id).people.map((p: { name: string }) => p.name)).toEqual(['Elin']);
  });

  it("shows every agent's program, tool, and alarm to everyone, and opens the card only of agents the person opens", async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const companyId = company!.id;
    const all = await db.select().from(agents);
    const orchestrator = all.find(a => a.kind === 'orchestrator')!;
    const [dev, sales] = await db
      .insert(departments)
      .values([
        { companyId, templateKey: 'development', roleCode: 'DEV', position: 0 },
        { companyId, templateKey: 'sales', roleCode: 'SAL', position: 1 },
      ])
      .returning();
    const [bruno, sally] = await db
      .insert(agents)
      .values([
        { companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: sub!.id },
        { companyId, kind: 'worker', name: 'Sally', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
      ])
      .returning();
    const startedAt = new Date('2026-11-03T10:00:00.000Z');
    const reportedAt = new Date(startedAt.getTime() + 5 * 60_000);
    const alarmAt = new Date(reportedAt.getTime() + SILENT_TURN_MS);
    const [devTurn, salesTurn, orchTurn] = await db
      .insert(jobs)
      .values([
        { companyId, subscriptionId: sub!.id, agentId: bruno!.id, kind: 'conversation', prompt: 'build', status: 'running', timeoutMs: 900_000, startedAt },
        { companyId, subscriptionId: sub!.id, agentId: sally!.id, kind: 'conversation', prompt: 'sell', status: 'running', timeoutMs: 900_000, startedAt },
        { companyId, subscriptionId: sub!.id, agentId: orchestrator.id, kind: 'conversation', prompt: 'plan', status: 'running', timeoutMs: 900_000, startedAt },
      ])
      .returning();
    await handleNodeMessage(app.ctx, BUILTIN, { type: 'job.program', jobId: devTurn!.id, state: 'tool', since: reportedAt.getTime(), tool: 'Bash', screenAt: reportedAt.getTime() }, reportedAt);
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: salesTurn!.id, state: 'tool', since: reportedAt.getTime(), tool: 'payroll.ExportSalaries', screenAt: reportedAt.getTime() },
      reportedAt,
    );
    await handleNodeMessage(
      app.ctx,
      BUILTIN,
      { type: 'job.program', jobId: orchTurn!.id, state: 'tool', since: reportedAt.getTime(), tool: 'company.Reorg', screenAt: reportedAt.getTime() },
      reportedAt,
    );
    await checkSilentTurns(app.ctx, alarmAt);

    const devPerson = await invitePerson(app, ceo, { name: 'Dev', email: 'dev@acme.com', access: { departments: [dev!.id] } });
    await ownPlan(db, 'dev@acme.com', bruno!.id, sally!.id);

    const ceoOrg = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(ceoOrg.orchestrator.program).toMatchObject({ state: 'tool', tool: 'company.Reorg' });
    expect(ceoOrg.orchestrator.alarm).toEqual({ reason: 'node_silent', since: reportedAt.getTime() });
    expect(ceoOrg.departments.find((d: { id: string }) => d.id === sales!.id).employees[0]).toMatchObject({
      program: { state: 'tool', tool: 'payroll.ExportSalaries' },
      alarm: { reason: 'node_silent', since: reportedAt.getTime() },
    });

    const devOrg = (await app.inject({ url: '/api/org', ...as(devPerson) })).json();
    const devEmployee = devOrg.departments.find((d: { id: string }) => d.id === dev!.id).employees[0];
    expect(devEmployee.program).toEqual({
      state: 'tool',
      since: reportedAt.getTime(),
      tool: 'Bash',
      screenAt: reportedAt.getTime(),
      signAt: null,
      retry: null,
      reportedAt: reportedAt.getTime(),
    });
    expect(devEmployee.alarm).toEqual({ reason: 'node_silent', since: reportedAt.getTime() });
    expect(devOrg.departments.find((d: { id: string }) => d.id === sales!.id).employees).toMatchObject([{
      id: sally!.id,
      opens: false,
      program: { state: 'tool', tool: 'payroll.ExportSalaries' },
      alarm: { reason: 'node_silent', since: reportedAt.getTime() },
    }]);
    expect(devOrg.orchestrator).toMatchObject({ opens: false, program: { state: 'tool', tool: 'company.Reorg' }, alarm: { reason: 'node_silent', since: reportedAt.getTime() } });

    const ownCard = await app.inject({ url: `/api/agents/${bruno!.id}`, ...as(devPerson) });
    expect(ownCard.statusCode).toBe(200);
    expect(ownCard.json().program).toMatchObject({ state: 'tool', tool: 'Bash' });
    expect(ownCard.json().alarm).toEqual({ reason: 'node_silent', since: reportedAt.getTime() });
    expect((await app.inject({ url: `/api/agents/${sally!.id}`, ...as(devPerson) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/agents/orchestrator', ...as(devPerson) })).statusCode).toBe(403);
  });
});
