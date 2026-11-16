import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { API_MODELS } from '@hornhoof/protocol';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { runsTier } from '../src/modules/tools/staff.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, people, proposals, subscriptions, teams } from '../src/db/schema.js';
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
  it('lets the plans of programs that run a deep model serve deep roles, and Kimi and GLM the others', () => {
    for (const provider of ['claude', 'codex', 'antigravity', 'anthropic_api', 'openai_api'] as const) expect(runsTier(provider, 'deep')).toBe(true);
    for (const provider of ['kimi', 'glm'] as const) expect(runsTier(provider, 'deep')).toBe(false);
    expect(runsTier('kimi', 'standard')).toBe(true);
  });

  it('lists what a department can be staffed with', async () => {
    const c = await company();
    const client = await tools(c);
    expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['add_api_key', 'add_plan_to_machine', 'add_repository', 'add_tasks', 'answer_request', 'approval_policy', 'ask_computer_access', 'ask_person', 'backlog', 'build_structure', 'cancel_task', 'cancel_update', 'change_employee', 'change_orchestrator', 'change_person', 'check_updates', 'close_improvement', 'comment', 'company', 'computer', 'computer_result', 'connect_plans', 'create_google_sheet', 'create_repository', 'database', 'disconnect_machine', 'edit_turn', 'escalate_missed_goal', 'explain_request', 'fire_employee', 'forget', 'hire', 'improvements', 'inbox', 'inbox_mark', 'invite_again', 'invite_person', 'lend_machine', 'machine_command', 'machines', 'merge_conflicts', 'merge_pick', 'message_employee', 'move_orchestrator', 'notebook', 'outbound_channel_create', 'outbound_channel_reopen', 'outbound_channel_stop', 'outbound_contact_suppress', 'outbound_options', 'outbound_policy_set', 'outbound_propose', 'outbound_status', 'outbound_submit', 'pause_task', 'pipeline_report', 'plan_command', 'pool', 'program_keys', 'program_recovery_release', 'program_screen', 'propose_staff', 'propose_structure', 'remember', 'remove_public_link', 'remove_repository', 'remove_subscription', 'replan_wait', 'report', 'request_approval', 'reset_employee', 'resolve_goal_risk', 'resume_task', 'rewrite_note', 'send_telegram_file', 'set_approval_policy', 'set_budget', 'set_department_owner', 'set_public_link', 'set_repository', 'set_team_urgent_only', 'set_urgent', 'set_wait_policy', 'staffing_options', 'stop_employee', 'support_classify', 'support_submit', 'task', 'tasks', 'test_subscription', 'turns', 'update_hornhoof', 'update_task', 'vault_entries', 'vault_fill', 'view', 'wait_for']);
    const res = await client.callTool({ name: 'staffing_options', arguments: { department: c.dev.id } });
    const options = JSON.parse(text(res));
    expect(options.department).toEqual({ id: c.dev.id, name: 'Development', products: c.products.map(p => ({ id: p.id, name: p.name })), employees: [] });
    expect(options.roster[0]).toMatchObject({ role: 'DEV-HEAD', kind: 'head', tier: 'deep', inDefault: true });
    const be = options.roster.find((r: { role: string }) => r.role === 'DEV-BE');
    expect(be).toMatchObject({ title: 'Backend engineer', kind: 'member', perProduct: false });
    const fe = options.roster.find((r: { role: string }) => r.role === 'DEV-FE');
    expect(fe).toMatchObject({ title: 'Frontend', kind: 'member', perProduct: false });
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
      ['Hanna', 'head', 'DEV-HEAD', 'claude-opus-5-5', c.teamKey],
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

  it('refuses hiring to people without the whole company or the department, and a line without its locked skills', async () => {
    const c = await company();
    const [oleg] = await c.db.select().from(people).where(eq(people.name, 'Oleg'));
    const olegToken = await (async () => {
      const res = await c.app.inject({ method: 'POST', url: `/api/people/${oleg!.id}/invite`, ...as(c.ceo) });
      const token = new URL(res.json().inviteUrl).pathname.split('/').pop()!;
      const accepted = await c.app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: 'correct horse battery' } });
      return accepted.cookies.find(k => k.name === 'hh_session')!.value;
    })();
    const sam = await invitePerson(c.app, c.ceo, { name: 'Sam', email: 'sam@acme.com', access: { departments: [c.sales.id] } });
    const line = { role: 'DEV-BE', name: 'Bruno', model: '', subscription: null, skills: ['dev-implement'] };
    expect((await hire(c.app, sam, c.dev.id, { people: [line] })).json().error.reason).toBe('department_owner_only');
    expect((await hire(c.app, olegToken, c.dev.id, { people: [line] })).json().error.reason).toBe('staff_invalid');
    const res = await hire(c.app, c.ceo, c.dev.id, { people: [line] });
    expect(res.json().error.reason).toBe('staff_invalid');
    expect(res.json().error.message).toContain('hh-hornhoof');
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
    /* Each line names the model its role's tier asks for on its plan: the middle one for the head, a strong one for the one who checks. */
    expect(roster[0]).toMatchObject({ role: 'DSN-HEAD', model: 'claude-sonnet-5-5', subscription: c.orchestrator.subscriptionId });
    expect(roster.find((l: { role: string }) => l.role === 'DSN-QA')).toMatchObject({ model: 'claude-opus-5-5' });
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

  it('names the model of a hire that came without one by its role, keeps a named one, and leaves one with no plan to its default', async () => {
    const c = await company();
    const line = (role: string, over: object = {}) => ({ role, name: role, product: null, model: '', subscription: c.teamKey, skills: c.app.ctx.templates.roles.get(role)!.skills.filter(skill => skill.on).map(skill => skill.id), ...over });
    const people = [line('DEV-SEC'), line('DEV-ENG'), line('DEV-REV', { model: 'claude-fable-5-1' }), line('DEV-DOCS', { subscription: null })];
    expect((await hire(c.app, c.ceo, c.dev.id, { people })).statusCode).toBe(201);
    const hired = await c.db.select({ role: agents.roleKey, model: agents.model }).from(agents).where(eq(agents.departmentId, c.dev.id));
    expect(Object.fromEntries(hired.map(a => [a.role, a.model]))).toEqual({ 'DEV-SEC': 'claude-fable-5-1', 'DEV-ENG': 'claude-sonnet-5-5', 'DEV-REV': 'claude-fable-5-1', 'DEV-DOCS': '' });
  });

  it('creates a department with the people of its template when asked, each on the model its role asks for', async () => {
    const c = await company();
    const built = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'marketing', staff: true }, { template: 'support' }] }, ...as(c.ceo) });
    expect(built.statusCode).toBe(201);
    const [marketing] = await c.db.select().from(departments).where(eq(departments.templateKey, 'marketing'));
    const [support] = await c.db.select().from(departments).where(eq(departments.templateKey, 'support'));
    const staff = await c.db.select().from(agents).where(and(eq(agents.departmentId, marketing!.id), isNull(agents.teamId))).orderBy(asc(agents.roleKey));
    expect(staff.map(a => [a.roleKey, a.kind, a.model, a.subscriptionId])).toEqual([
      ['MKT-EDIT', 'worker', 'claude-opus-5-5', c.orchestrator.subscriptionId],
      ['MKT-HEAD', 'head', 'claude-sonnet-5-5', c.orchestrator.subscriptionId],
      ['MKT-SEO', 'worker', 'claude-sonnet-5-5', c.orchestrator.subscriptionId],
      ['MKT-SOCIAL', 'worker', 'claude-haiku-5-5', c.orchestrator.subscriptionId],
      ['MKT-WRITE', 'worker', 'claude-sonnet-5-5', c.orchestrator.subscriptionId],
    ]);
    expect(built.json().hired).toEqual(expect.arrayContaining(staff.map(a => a.id)));
    /* A department that was not asked for its people comes empty, as before. */
    expect(await c.db.select().from(agents).where(eq(agents.departmentId, support!.id))).toEqual([]);
  });

  it('creates the turnkey team of a template with its members, each on the strongest model, since nobody checks after them', async () => {
    const c = await company();
    const built = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'marketing', staff: true }] }, ...as(c.ceo) });
    expect(built.statusCode).toBe(201);
    const [marketing] = await c.db.select().from(departments).where(eq(departments.templateKey, 'marketing'));
    const [team] = await c.db.select().from(teams).where(eq(teams.departmentId, marketing!.id));
    expect(team).toMatchObject({ name: 'Turnkey team', turnkey: true, urgentOnly: false });
    const members = await c.db.select().from(agents).where(eq(agents.teamId, team!.id));
    expect(members.map(a => [a.roleKey, a.kind, a.model, a.name])).toEqual([['MKT-WRITE', 'worker', 'claude-fable-5-1', 'Copywriter (Turnkey team)']]);
    /* A member does every check of its department alone, so it carries the skill of each on top of its role's. */
    expect(members[0]!.skills).toEqual(expect.arrayContaining(['mkt-copywriting', 'hh-check-work', 'mkt-product-context']));
    /* The same role outside the team keeps the strength the role asks for. */
    const [writer] = await c.db.select().from(agents).where(and(eq(agents.departmentId, marketing!.id), eq(agents.roleKey, 'MKT-WRITE'), isNull(agents.teamId)));
    expect(writer!.model).toBe('claude-sonnet-5-5');
    expect(built.json().hired).toHaveLength(6);
  });

  it('numbers the members of a team that has several of one role', async () => {
    const c = await company();
    const [team] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Turnkey team', turnkey: true }).returning();
    const skills = c.app.ctx.templates.roles.get('DEV-ENG')!.skills.filter(skill => skill.on).map(skill => skill.id);
    const people = [1, 2].map(n => ({ role: 'DEV-ENG', name: `Developer ${n}`, product: null, team: team!.id, model: '', subscription: c.teamKey, skills }));
    expect((await hire(c.app, c.ceo, c.dev.id, { people })).statusCode).toBe(201);
    const members = await c.db.select().from(agents).where(eq(agents.teamId, team!.id)).orderBy(asc(agents.name));
    expect(members.map(a => [a.name, a.model])).toEqual([['Developer 1', 'claude-fable-5-1'], ['Developer 2', 'claude-fable-5-1']]);
  });

  it('creates the people of a template with no plan to run on when the company has none that serves them: they wait for one', async () => {
    const c = await company();
    await c.db.update(subscriptions).set({ removedAt: new Date() });
    const built = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'finance', staff: true }] }, ...as(c.ceo) });
    expect(built.statusCode).toBe(201);
    const [finance] = await c.db.select().from(departments).where(eq(departments.templateKey, 'finance'));
    const staff = await c.db.select().from(agents).where(eq(agents.departmentId, finance!.id)).orderBy(asc(agents.roleKey));
    expect(staff.map(a => [a.roleKey, a.model, a.subscriptionId])).toEqual([['FIN-AUDIT', '', null], ['FIN-BOOK', '', null], ['FIN-FPA', '', null], ['FIN-FPA', '', null], ['FIN-HEAD', '', null]]);
  });

  it('tells the orchestrator who came with a new department, and to staff only the ones that came without people', async () => {
    const c = await company();
    const builtin: FakeNode = await connectNode(c.url, NODE_KEY);
    builtin.send({ type: 'hello', version: '0.4.0', loggedIn: true, running: [] });
    await until(async () => (await c.app.inject({ url: '/api/agents/orchestrator/events', ...as(c.ceo) })).json().state.ready);
    const built = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { items: [{ template: 'household', staff: true }] }, ...as(c.ceo) });
    expect(built.statusCode).toBe(201);
    let run = await builtin.next();
    while (run.type !== 'job.run') run = await builtin.next();
    expect(run.prompt).toContain('Hired with their departments, by the templates: Head of household (Head of household), ');
    expect(run.prompt).toContain('offer to staff the departments that came without people');
    expect(run.prompt).not.toContain('wait for one');
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

  it('hires and moves an employee into a sub-unit of its own department, and refuses a sub-unit of another department, a missing sub-unit, or a head in a sub-unit', async () => {
    const c = await company();
    const client = await tools(c);
    const [urgent] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.dev.id, name: 'Urgent fixes' }).returning();
    const [inbound] = await c.db.insert(teams).values({ companyId: c.companyId, departmentId: c.sales.id, name: 'Inbound' }).returning();
    const missingTeam = '00000000-0000-4000-8000-000000000099';
    const beSkills = c.app.ctx.templates.roles.get('DEV-BE')!.skills.filter(s => s.on).map(s => s.id);
    const headSkills = c.app.ctx.templates.roles.get('DEV-HEAD')!.skills.filter(s => s.on).map(s => s.id);

    for (const [line, message] of [
      [{ role: 'DEV-HEAD', name: 'Hanna', team: urgent!.id, model: '', subscription: c.teamKey, skills: headSkills }, 'head cannot be in a sub-unit'],
      [{ role: 'DEV-BE', name: 'Bruno', team: inbound!.id, model: '', subscription: c.teamKey, skills: beSkills }, inbound!.id],
      [{ role: 'DEV-BE', name: 'Bruno', team: missingTeam, model: '', subscription: c.teamKey, skills: beSkills }, missingTeam],
    ] as const) {
      const badHire = await hire(c.app, c.ceo, c.dev.id, { people: [line] });
      expect(badHire.statusCode).toBe(400);
      expect(badHire.json().error.reason).toBe('staff_invalid');
      expect(badHire.json().error.message).toContain(message);

      const badProposal = await client.callTool({ name: 'propose_staff', arguments: { department: c.dev.id, brief: 'x', people: [{ checked: true, role: line.role, team: line.team }] } });
      expect(failed(badProposal)).toBe(true);
      expect(text(badProposal)).toContain(message);
    }

    const validProposal = await client.callTool({
      name: 'propose_staff',
      arguments: { department: c.dev.id, brief: 'Urgent lane.', people: [{ checked: true, role: 'DEV-BE', name: 'Robin', team: urgent!.id, subscription: c.teamKey }] },
    });
    expect(failed(validProposal)).toBe(false);

    const hired = await hire(c.app, c.ceo, c.dev.id, {
      people: [
        { role: 'DEV-HEAD', name: 'Hanna', model: '', subscription: c.teamKey, skills: headSkills },
        { role: 'DEV-BE', name: 'Robin', team: urgent!.id, model: '', subscription: c.teamKey, skills: beSkills },
        { role: 'DEV-BE', name: 'Bruno', model: '', subscription: c.teamKey, skills: beSkills },
      ],
    });
    expect(hired.statusCode).toBe(201);
    const [hannaId, robinId, brunoId] = hired.json().hired as [string, string, string];
    expect((await c.db.select().from(agents).where(eq(agents.id, robinId)))[0]!.teamId).toBe(urgent!.id);

    for (const badMove of [
      { id: hannaId, team: urgent!.id },
      { id: brunoId, team: inbound!.id },
      { id: brunoId, team: missingTeam },
    ]) {
      const patchRes = await c.app.inject({ method: 'PATCH', url: `/api/agents/${badMove.id}`, payload: { team: badMove.team }, ...as(c.ceo) });
      expect(patchRes.statusCode).toBe(400);
      expect(patchRes.json().error.reason).toBe('unknown_place');
      const toolRes = await client.callTool({ name: 'change_employee', arguments: { employee: badMove.id, team: badMove.team } });
      expect(failed(toolRes)).toBe(true);
    }

    const movedIn = await c.app.inject({ method: 'PATCH', url: `/api/agents/${brunoId}`, payload: { team: urgent!.id }, ...as(c.ceo) });
    expect(movedIn.statusCode).toBe(200);
    expect((await c.db.select().from(agents).where(eq(agents.id, brunoId)))[0]!.teamId).toBe(urgent!.id);
  });
});
