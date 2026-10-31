import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API_MODELS } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, people, proposals, subscriptions } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = 'tool-token-0123456789abcdef0123456789';

/* A company with Development (two products), Design (the same two) and Sales, a key for any department, a plan of a
   person in Development and one of a person in Sales. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const built = await app.inject({
    method: 'POST',
    url: '/api/departments/build',
    payload: { items: [{ template: 'development', products: ['Mascot', 'Characters'] }, { template: 'design', products: ['Mascot', 'Characters'] }, { template: 'sales' }] },
    ...as(ceo),
  });
  expect(built.statusCode).toBe(201);
  const top = await db.select().from(departments).where(isNull(departments.parentId)).orderBy(asc(departments.position));
  const [dev, design, sales] = top;
  const products = await db.select().from(departments).where(eq(departments.parentId, dev!.id)).orderBy(asc(departments.position));
  const key = await app.inject({
    method: 'POST',
    url: '/api/subscriptions',
    payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Team key', apiKey: 'sk-ant-api03-team-key-5678', target: { kind: 'any' } },
    ...as(ceo),
  });
  expect(key.statusCode).toBe(201);
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [dev!.id] } });
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [sales!.id] } });
  const plan = async (token: string, provider: string) => {
    const id = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: [provider] }, ...as(token) })).json().subscriptions[0].id as string;
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, id));
    return id;
  };
  const olegCodex = await plan(oleg, 'codex');
  await db.update(subscriptions).set({ models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] }).where(eq(subscriptions.id, olegCodex));
  const mariaClaude = await plan(maria, 'claude');
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return { app, db, url, ceo, companyId: acme!.id, dev: dev!, design: design!, sales: sales!, products, teamKey: key.json().subscription.id as string, olegCodex, mariaClaude, orchestrator: orchestrator! };
}

type Company = Awaited<ReturnType<typeof company>>;

/* The orchestrator's tools as his running turn sees them. */
async function tools(c: Company): Promise<Client> {
  const [sub] = await c.db.select().from(subscriptions).where(eq(subscriptions.id, c.orchestrator.subscriptionId!));
  await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: sub!.id, agentId: c.orchestrator.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(TOKEN) });
  const url = new URL(`http://127.0.0.1:${(c.app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  onTestFinished(() => client.close());
  return client;
}

const text = (res: unknown) => (res as { content: { text: string }[] }).content[0]!.text;
const failed = (res: unknown) => Boolean((res as { isError?: boolean }).isError);

const hire = (app: FastifyInstance, token: string, departmentId: string, body: object) => app.inject({ method: 'POST', url: `/api/departments/${departmentId}/staff`, payload: body, ...as(token) });

describe('staffing', () => {
  it('lists what a department can be staffed with', async () => {
    const c = await company();
    const client = await tools(c);
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['add_api_key', 'add_tasks', 'answer_request', 'ask_person', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'comment', 'company', 'connect_plans', 'disconnect_machine', 'edit_turn', 'explain_request', 'fire_employee', 'forget', 'hire', 'improvements', 'invite_again', 'invite_person', 'message_employee', 'move_orchestrator', 'notebook', 'plan_command', 'plan_turn', 'propose_staff', 'propose_structure', 'remember', 'remove_repository', 'remove_subscription', 'report', 'reset_employee', 'rewrite_note', 'set_repository', 'staffing_options', 'stop_employee', 'task', 'tasks', 'test_subscription', 'turns', 'update_hornhoof', 'update_task', 'view']);
    const res = await client.callTool({ name: 'staffing_options', arguments: { department: c.dev.id } });
    const options = JSON.parse(text(res));
    expect(options.department).toEqual({ id: c.dev.id, name: 'Development', products: c.products.map(p => ({ id: p.id, name: p.name })), employees: [] });
    expect(options.roster[0]).toMatchObject({ role: 'DEV-HEAD', kind: 'head', tier: 'deep', inDefault: true });
    const be = options.roster.find((r: { role: string }) => r.role === 'DEV-BE');
    expect(be).toMatchObject({ title: 'Backend engineer', kind: 'member', perProduct: false });
    expect(be.skills).toContainEqual({ id: 'dev-engineering-rules', on: true, locked: false });
    expect(be.skills).toContainEqual({ id: 'hh-report-to-head', on: true, locked: true });
    expect(options.subscriptions.map((s: { id: string }) => s.id)).toEqual([c.olegCodex, c.orchestrator.subscriptionId, c.teamKey]);
    expect(options.subscriptions.find((s: { id: string }) => s.id === c.teamKey)).toMatchObject({ provider: 'anthropic_api', label: 'Team key', models: API_MODELS.anthropic_api });
    expect(options.subscriptions.find((s: { id: string }) => s.id === c.olegCodex)).toMatchObject({ provider: 'codex', owner: 'Oleg', models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }] });
    expect(failed(await client.callTool({ name: 'staffing_options', arguments: { department: '00000000-0000-4000-8000-000000000000' } }))).toBe(true);
  });

  it('stores a staff proposal and replaces an older one for the same department', async () => {
    const c = await company();
    const client = await tools(c);
    const structure = await client.callTool({ name: 'propose_structure', arguments: { brief: 'Acme makes characters.', items: [{ template: 'support', checked: true, note: 'Schools ask questions' }] } });
    expect(failed(structure)).toBe(false);
    const people = [
      { role: 'DEV-HEAD', checked: true },
      { role: 'DEV-BE', name: 'Bruno', model: 'claude-sonnet-5-5', subscription: c.teamKey, checked: true },
    ];
    const first = await client.callTool({ name: 'propose_staff', arguments: { department: c.dev.id, brief: 'Start with the API.', people } });
    expect(failed(first)).toBe(false);
    await client.callTool({ name: 'propose_staff', arguments: { department: c.dev.id, brief: 'API and the web app.', people: [...people, { role: 'DEV-FE', checked: true }] } });
    const rows = await c.db.select().from(proposals).orderBy(asc(proposals.createdAt));
    expect(rows.map(r => [r.kind, r.status])).toEqual([
      ['structure', 'pending'],
      ['staff', 'dismissed'],
      ['staff', 'pending'],
    ]);
    expect(rows[2]).toMatchObject({ departmentId: c.dev.id, brief: 'API and the web app.' });
    const events = await c.db.select().from(agentEvents).where(eq(agentEvents.kind, 'proposal')).orderBy(asc(agentEvents.seq));
    expect(events[2]!.data).toMatchObject({ proposalId: rows[2]!.id, kind: 'staff', department: c.dev.id, brief: 'API and the web app.' });
  });

  it('refuses a role from another department, a model the subscription cannot run, a subscription that cannot serve the department', async () => {
    const c = await company();
    const client = await tools(c);
    const propose = (line: object) => client.callTool({ name: 'propose_staff', arguments: { department: c.dev.id, brief: 'x', people: [{ checked: true, ...line }] } });
    const cases: [object, string][] = [
      [{ role: 'SAL-AE' }, 'SAL-AE'],
      [{ role: 'DEV-BE', subscription: c.teamKey, model: 'gpt-6.1-sol' }, 'gpt-6.1-sol'],
      [{ role: 'DEV-BE', subscription: c.mariaClaude }, 'cannot serve'],
      [{ role: 'DEV-BE', product: c.sales.id }, 'product'],
      [{ role: 'DEV-BE', skills: { on: ['no-such-skill'], off: [] } }, 'no-such-skill'],
      [{ role: 'DEV-BE', skills: { on: [], off: ['hh-report-to-head'] } }, 'hh-report-to-head'],
    ];
    for (const [line, says] of cases) {
      const res = await propose(line);
      expect(failed(res)).toBe(true);
      expect(text(res)).toContain(says);
    }
    expect(await c.db.select().from(proposals)).toHaveLength(0);
  });

  it('hires the ticked people with their models, subscriptions and skills', async () => {
    const c = await company();
    const client = await tools(c);
    await client.callTool({ name: 'propose_staff', arguments: { department: c.dev.id, brief: 'Start with the API.', people: [{ role: 'DEV-HEAD', checked: true }] } });
    const [proposal] = await c.db.select().from(proposals);
    const be = c.app.ctx.templates.roles.get('DEV-BE')!;
    const skills = [...be.skills.filter(s => s.on).map(s => s.id), 'dev-api-design'];
    const res = await hire(c.app, c.ceo, c.dev.id, {
      proposalId: proposal!.id,
      people: [
        { role: 'DEV-HEAD', name: 'Hanna', model: '', subscription: c.teamKey, skills: c.app.ctx.templates.roles.get('DEV-HEAD')!.skills.filter(s => s.on).map(s => s.id) },
        { role: 'DEV-BE', name: 'Bruno', product: c.products[0]!.id, model: 'gpt-6.1-sol', subscription: c.olegCodex, skills },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().hired).toHaveLength(2);
    const staff = await c.db.select().from(agents).where(eq(agents.departmentId, c.dev.id)).orderBy(asc(agents.name));
    expect(staff.map(a => [a.name, a.kind, a.roleKey, a.model, a.subscriptionId])).toEqual([
      ['Bruno', 'worker', 'DEV-BE', 'gpt-6.1-sol', c.olegCodex],
      ['Hanna', 'head', 'DEV-HEAD', '', c.teamKey],
    ]);
    const [ceo] = await c.db.select().from(people).where(eq(people.isOwner, true));
    expect(staff[0]).toMatchObject({ productId: c.products[0]!.id, skills, createdBy: ceo!.id });
    expect(staff[0]!.templateHashes).toMatchObject({ 'DEV-BE': be.hash, 'dev-api-design': c.app.ctx.templates.skills.get('dev-api-design')!.hash });
    const changes = await c.db.select().from(agentChanges);
    expect(changes.map(ch => [ch.field, ch.personId])).toEqual([
      ['hired', ceo!.id],
      ['hired', ceo!.id],
    ]);
    expect((await c.db.select().from(proposals))[0]!.status).toBe('applied');
    const applied = await c.db.select().from(agentEvents).where(and(eq(agentEvents.agentId, c.orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied.at(-1)!.data).toMatchObject({ proposalId: proposal!.id, kind: 'staff', hired: [{ name: 'Hanna', role: 'DEV-HEAD' }, { name: 'Bruno', role: 'DEV-BE' }] });
    const again = await hire(c.app, c.ceo, c.dev.id, { proposalId: proposal!.id, people: [] });
    expect(again.statusCode).toBe(400);
    const closed = await hire(c.app, c.ceo, c.dev.id, { proposalId: proposal!.id, people: [{ role: 'DEV-QA', name: 'Quinn', model: '', subscription: null, skills: [] }] });
    expect(closed.json().error.reason).toBe('proposal_closed');
  });

  it('refuses a second head', async () => {
    const c = await company();
    const head = (name: string) => ({ role: 'DEV-HEAD', name, model: '', subscription: c.teamKey, skills: c.app.ctx.templates.roles.get('DEV-HEAD')!.skills.filter(s => s.on).map(s => s.id) });
    const two = await hire(c.app, c.ceo, c.dev.id, { people: [head('Hanna'), head('Henry')] });
    expect(two.statusCode).toBe(400);
    expect(two.json().error.reason).toBe('staff_invalid');
    expect((await hire(c.app, c.ceo, c.dev.id, { people: [head('Hanna')] })).statusCode).toBe(201);
    const second = await hire(c.app, c.ceo, c.dev.id, { people: [head('Henry')] });
    expect(second.statusCode).toBe(400);
    expect(second.json().error.message).toContain('already has a head');
    expect(await c.db.select().from(agents).where(eq(agents.kind, 'head'))).toHaveLength(1);
  });

  it('refuses hiring to people without the whole company and a line without its locked skills', async () => {
    const c = await company();
    const [oleg] = await c.db.select().from(people).where(eq(people.name, 'Oleg'));
    const olegToken = await (async () => {
      const res = await c.app.inject({ method: 'POST', url: `/api/people/${oleg!.id}/invite`, ...as(c.ceo) });
      const token = new URL(res.json().inviteUrl).pathname.split('/').pop()!;
      const accepted = await c.app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } });
      return accepted.cookies.find(k => k.name === 'hh_session')!.value;
    })();
    const line = { role: 'DEV-BE', name: 'Bruno', model: '', subscription: null, skills: ['dev-implement'] };
    expect((await hire(c.app, olegToken, c.dev.id, { people: [line] })).json().error.reason).toBe('company_scope_only');
    const res = await hire(c.app, c.ceo, c.dev.id, { people: [line] });
    expect(res.json().error.reason).toBe('staff_invalid');
    expect(res.json().error.message).toContain('hh-outside-is-data');
  });

  it('offers the company key from setup to every department', async () => {
    const { app, ceo, sales, orchestrator } = await company();
    const roster = (await app.inject({ url: `/api/departments/${sales.id}/roster`, ...as(ceo) })).json();
    expect(roster.subscriptions.map((s: { id: string }) => s.id)).toContain(orchestrator.subscriptionId);
  });

  it("starts new employees on a key bought for the department before a company-wide one", async () => {
    const { app, ceo, design } = await company();
    const own = await app.inject({
      method: 'POST',
      url: '/api/subscriptions',
      payload: { provider: 'anthropic_api', kind: 'api_key', label: 'Design key', apiKey: 'sk-ant-api03-design-key-9012', target: { kind: 'department', id: design.id } },
      ...as(ceo),
    });
    expect(own.statusCode).toBe(201);
    const roster = (await app.inject({ url: `/api/departments/${design.id}/roster`, ...as(ceo) })).json();
    expect(roster.roles[0]).toMatchObject({ id: 'DSN-HEAD', subscription: own.json().subscription.id });
  });

  it('offers the default roster by hand, one designer per product', async () => {
    const c = await company();
    const res = await c.app.inject({ url: `/api/departments/${c.design.id}/roster`, ...as(c.ceo) });
    expect(res.statusCode).toBe(200);
    const roster = res.json().people;
    const designProducts = await c.db.select().from(departments).where(eq(departments.parentId, c.design.id)).orderBy(asc(departments.position));
    const ui = roster.filter((l: { role: string }) => l.role === 'DSN-UI');
    expect(ui.map((l: { product: string; name: string }) => [l.product, l.name])).toEqual(designProducts.map(p => [p.id, `Product UI designer (${p.name})`]));
    expect(roster[0]).toMatchObject({ role: 'DSN-HEAD', model: '', subscription: c.orchestrator.subscriptionId });
    for (const l of roster) expect(l.skills).toContain(l.role === 'DSN-HEAD' ? 'hh-lead-tasks' : 'hh-task-flow');
    const { roles, products, subscriptions } = res.json();
    expect(roles[0]).toMatchObject({ id: 'DSN-HEAD', kind: 'head', subscription: c.orchestrator.subscriptionId });
    expect(roles[0].skills).toContain('hh-lead-tasks');
    expect(roles.find((r: { id: string }) => r.id === 'DSN-UI')).toMatchObject({ title: { en: 'Product UI designer' }, kind: 'member', perProduct: true });
    expect(products).toEqual(designProducts.map(p => ({ id: p.id, name: p.name })));
    expect(subscriptions.find((s: { id: string }) => s.id === c.teamKey)).toMatchObject({ provider: 'anthropic_api', label: 'Team key', models: API_MODELS.anthropic_api });
    const dev = (await c.app.inject({ url: `/api/departments/${c.dev.id}/roster`, ...as(c.ceo) })).json().people;
    expect(dev.map((l: { role: string }) => l.role)).not.toContain('DEV-DOCS');
    expect((await hire(c.app, c.ceo, c.design.id, { people: roster })).statusCode).toBe(201);
  });

  it('tells the orchestrator who was hired', async () => {
    const c = await company();
    const builtin: FakeNode = await connectNode(c.url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.4.0', loggedIn: true, running: [] });
    await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceo) })).json().state.ready);
    const res = await hire(c.app, c.ceo, c.sales.id, { people: [{ role: 'SAL-HEAD', name: 'Sasha', model: '', subscription: c.teamKey, skills: c.app.ctx.templates.roles.get('SAL-HEAD')!.skills.filter(s => s.on).map(s => s.id) }] });
    expect(res.statusCode).toBe(201);
    let run = await builtin.next();
    while (run.type !== 'job.run') run = await builtin.next();
    expect(run.prompt).toContain('Hired in Sales: Sasha (Head of sales)');
  });
});
