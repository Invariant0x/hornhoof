import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, people, proposals, publicLinks, requests, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { fakeRelay } from './fake-relay.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const TOKEN = 'tool-token-0123456789abcdef0123456789';
const WORKER_TOKEN = 'tool-token-worker-0123456789abcdef01';

/* A company on the built-in node with Development, Hana at its head and Bruno in it, Hana's task for Bruno, and a running
   turn of the orchestrator whose token reaches its tools. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_KEY, ...env });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  onTestFinished(() => builtin.close());
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [acme] = await db.select().from(companies);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  await until(() => app.ctx.hub.isReady(identityOf(sub!)));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const running = (agentId: string, token: string) =>
    db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token) });
  await running(orchestrator!.id, TOKEN);
  const task = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, gates: [] })).task;
  return { app, db, ceo, orchestrator: orchestrator!, hana, bruno, dev: dev!, task, running };
}

async function mcp(app: FastifyInstance, token = TOKEN): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  onTestFinished(() => client.close());
  return client;
}

type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: object) => (await client.callTool({ name, arguments: args })) as Result;
const text = (res: Result) => res.content[0]!.text;

describe('the orchestrator runs the company as the CEO can in Hornhoof', () => {
  it("sets an employee's timer and takes it away", async () => {
    const { app, db, bruno } = await company();
    const client = await mcp(app);
    const set = await call(client, 'change_employee', { employee: bruno.id, timer: { minutes: 60, order: 'Read the failed jobs of the last hour.' } });
    expect(set.isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]).toMatchObject({ timerMinutes: 60, timerOrder: 'Read the failed jobs of the last hour.' });
    await call(client, 'change_employee', { employee: bruno.id, timer: null });
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.timerMinutes).toBeNull();
  });

  it('changes its own effort as its card does, and keeps to what the card changes', async () => {
    const { app, db, orchestrator } = await company();
    const client = await mcp(app);
    expect((await call(client, 'change_orchestrator', { effort: 'high' })).isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, orchestrator.id)))[0]!.effort).toBe('high');
    const changes = await db.select().from(agentChanges).where(eq(agentChanges.agentId, orchestrator.id));
    expect(changes.map(c => [c.field, c.after, c.byOrchestrator])).toEqual([['effort', 'high', true]]);
    expect((await call(client, 'change_orchestrator', { effort: 'loud' })).isError).toBe(true);
  });

  it('switches an employee off and on, and the card says the orchestrator did it', async () => {
    const { app, db, ceo, bruno } = await company();
    const client = await mcp(app);
    const off = await call(client, 'change_employee', { employee: bruno.id, on: false });
    expect(off.isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.switchedOffAt).not.toBeNull();
    await call(client, 'change_employee', { employee: bruno.id, on: true });
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.switchedOffAt).toBeNull();
    const changes = await db.select().from(agentChanges).where(eq(agentChanges.agentId, bruno.id));
    expect(changes.map(c => [c.field, c.personId, c.byOrchestrator])).toEqual([
      ['switch', null, true],
      ['switch', null, true],
    ]);
    const card = (await app.inject({ url: `/api/agents/${bruno.id}`, ...as(ceo) })).json();
    expect(card.changes[0]).toMatchObject({ field: 'switch', personName: null, byOrchestrator: true });
  });

  it('is refused what the CEO would be refused, in the same words', async () => {
    const { app, orchestrator } = await company();
    const res = await call(await mcp(app), 'fire_employee', { employee: orchestrator.id });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('The orchestrator stays with the company.');
  });

  it('writes to an employee as itself', async () => {
    const { app, db, bruno } = await company();
    const res = await call(await mcp(app), 'message_employee', { employee: bruno.id, text: 'Please look at the checkout bug first.' });
    expect(res.isError).toBeFalsy();
    const [turn] = await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), isNull(jobs.taskId)));
    expect(turn!.prompt).toMatch(/^Orchestrator: Please look at the checkout bug first\./);
    expect(turn!.createdBy).toBeNull();
    const [said] = await db.select().from(agentEvents).where(eq(agentEvents.agentId, bruno.id));
    expect(said).toMatchObject({ kind: 'message', personId: null, data: { text: 'Please look at the checkout bug first.', from: 'orchestrator' } });
  });

  it('reads any page the CEO can open', async () => {
    const { app } = await company();
    const res = await call(await mcp(app), 'view', { path: '/api/people' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).people[0]).toMatchObject({ title: 'CEO' });
    expect((await call(await mcp(app), 'view', { path: '/mcp' })).isError).toBe(true);
  });

  it('gives these tools to the orchestrator alone', async () => {
    const { app, bruno, running } = await company();
    await running(bruno.id, WORKER_TOKEN);
    const names = (await (await mcp(app, WORKER_TOKEN)).listTools()).tools.map(t => t.name);
    expect(names).not.toContain('change_employee');
    expect(names).not.toContain('view');
  });

  it('lets no one outside pass as the orchestrator', async () => {
    const { app, bruno } = await company();
    const res = await app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { on: false }, headers: { 'x-hornhoof-internal': 'guess', 'x-hornhoof-person': bruno.id, 'x-hornhoof-agent': bruno.id } });
    expect(res.statusCode).toBe(401);
  });

  it('does not write to itself', async () => {
    const { app, db, orchestrator } = await company();
    const res = await call(await mcp(app), 'message_employee', { employee: orchestrator.id, text: 'Remember to check the tests.' });
    expect(res.isError).toBe(true);
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), eq(jobs.status, 'queued')))).toEqual([]);
  });

  it('cancels a task that someone else gave', async () => {
    const { app, db, task } = await company();
    const res = await call(await mcp(app), 'cancel_task', { task: task.number, why: 'The CEO dropped checkout.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('cancelled');
  });

  it('rewrites any task', async () => {
    const { app, db, task } = await company();
    const res = await call(await mcp(app), 'update_task', { task: task.number, body: 'POST /checkout with tax.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.body).toBe('POST /checkout with tax.');
  });

  it('tells people when the turn that was to put a request into words ended without them', async () => {
    const { app, db, ceo, orchestrator, bruno, task } = await company();
    await db.delete(jobs).where(eq(jobs.agentId, orchestrator.id));
    const { request, wakes } = await ask(app.ctx, bruno.id, task.id, { kind: 'question', text: 'JWT or sessions for /checkout?' });
    await wakeAll(app.ctx, wakes);
    const [asked] = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id));
    const heard: string[] = [];
    app.ctx.bus.subscribe(task.companyId, m => heard.push(m.type));
    await db.update(jobs).set({ status: 'failed', error: 'agent_failed', finishedAt: new Date() }).where(eq(jobs.id, asked!.id));
    await afterJob(app.ctx, asked!.id);
    expect(heard).toContain('requests');
    expect((await app.inject({ url: '/api/requests', ...as(ceo) })).json().requests).toMatchObject([{ id: request.id, explained: null, explaining: false }]);
  });

  it('builds a department itself and is not woken about its own change', async () => {
    const { app, db, orchestrator } = await company();
    const res = await call(await mcp(app), 'build_structure', { items: [{ template: 'design', note: 'Screens for checkout.' }] });
    expect(res.isError).toBeFalsy();
    expect(await db.select().from(departments).where(eq(departments.templateKey, 'design'))).toHaveLength(1);
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), like(jobs.prompt, 'Hornhoof applied%')))).toEqual([]);
    const [applied] = await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.personId).toBeNull();
  });

  it('is asked to put what an employee asks a person into plain words, and its words show with the request', async () => {
    const { app, db, ceo, orchestrator, bruno, task, running } = await company();
    await db.delete(jobs).where(eq(jobs.agentId, orchestrator.id));
    const { request, wakes } = await ask(app.ctx, bruno.id, task.id, { kind: 'question', text: 'JWT or sessions for /checkout?' });
    await wakeAll(app.ctx, wakes);
    const [asked] = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id));
    expect(asked!.prompt).toContain(request.id);
    expect(asked!.prompt).toContain('\n> JWT or sessions for /checkout?');
    expect(asked!.prompt).toContain('explain_request');
    /* People see that the orchestrator is on it while its turn waits or runs. */
    expect((await app.inject({ url: '/api/requests', ...as(ceo) })).json().requests).toMatchObject([{ id: request.id, explained: null, explaining: true }]);
    await running(orchestrator.id, TOKEN);
    const plain = 'Бруно спрашивает, как входить в оплату. Нужно выбрать: проще (сессии) или для приложений тоже (JWT).';
    expect((await call(await mcp(app), 'explain_request', { request: request.id, text: plain })).isError).toBeFalsy();
    const listed = (await app.inject({ url: '/api/requests', ...as(ceo) })).json().requests;
    expect(listed).toMatchObject([{ id: request.id, explained: plain, explaining: false }]);
    /* People answer; only the orchestrator puts a request into words. */
    const byPerson = await app.inject({ method: 'POST', url: `/api/requests/${request.id}/explained`, payload: { text: 'x' }, ...as(ceo) });
    expect(byPerson.statusCode).toBe(403);
  });

  it('answers an employee\'s question as itself', async () => {
    const { app, db, orchestrator, bruno, task } = await company();
    const { request } = await ask(app.ctx, bruno.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    const res = await call(await mcp(app), 'answer_request', { request: request.id, answer: 'Yes, with tax.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'answered', answeredBy: null });
    const [said] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'answered')));
    expect(said).toMatchObject({ personId: null, agentId: orchestrator.id });
  });

  it('hires with what the card starts with and is not woken about it', async () => {
    const { app, db, orchestrator, dev } = await company();
    const res = await call(await mcp(app), 'hire', { department: dev.id, people: [{ role: 'DEV-QA' }] });
    expect(res.isError).toBeFalsy();
    const [qa] = await db.select().from(agents).where(eq(agents.roleKey, 'DEV-QA'));
    const role = app.ctx.templates.roles.get('DEV-QA')!;
    expect(qa).toMatchObject({ name: role.title.en, model: '', createdBy: null, skills: role.skills.filter(s => s.on).map(s => s.id) });
    expect(qa!.subscriptionId).not.toBeNull();
    const [hired] = await db.select().from(agentChanges).where(eq(agentChanges.agentId, qa!.id));
    expect(hired).toMatchObject({ field: 'hired', personId: null, byOrchestrator: true });
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), like(jobs.prompt, 'Hornhoof applied%')))).toEqual([]);
  });

  it('keeps a task nobody holds blocked when it rewrites it', async () => {
    const { app, db, orchestrator, hana, dev } = await company();
    const payments = (await createTask(app.ctx, { agentId: orchestrator.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: hana.id })).task;
    await db.update(tasks).set({ status: 'blocked', assigneeAgentId: null }).where(eq(tasks.id, payments.id));
    const res = await call(await mcp(app), 'update_task', { task: payments.number, body: 'Payments with tax.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, payments.id)))[0]).toMatchObject({ body: 'Payments with tax.', status: 'blocked' });
  });

  it('tells the head when it takes the last gate off a member task', async () => {
    const { app, db, hana, bruno, dev } = await company();
    const [rita] = await db.insert(agents).values({ companyId: dev.companyId, kind: 'worker', name: 'Rita', roleKey: 'DEV-REV', departmentId: dev.id, model: '', subscriptionId: bruno.subscriptionId }).returning();
    const checked = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Refunds', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, gates: [rita!.id] })).task;
    await db.update(tasks).set({ status: 'review', stage: 1, panel: [], assigneeAgentId: hana.id }).where(eq(tasks.id, checked.id));
    const res = await call(await mcp(app), 'update_task', { task: checked.number, gates: [] });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, checked.id)))[0]!.status).toBe('done');
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, hana.id), eq(jobs.taskId, checked.id)))).toHaveLength(1);
  });

  it('closes the staff card it hires from', async () => {
    const { app, db, dev } = await company();
    const client = await mcp(app);
    await call(client, 'propose_staff', { department: dev.id, brief: 'Acceptance first.', people: [{ role: 'DEV-QA', checked: true }] });
    const [card] = await db.select().from(proposals).where(eq(proposals.kind, 'staff'));
    const res = await call(client, 'hire', { department: dev.id, proposalId: card!.id, people: [{ role: 'DEV-QA' }] });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(proposals).where(eq(proposals.id, card!.id)))[0]!.status).toBe('applied');
  });

  it('records the plans a person it disables lets go as its own change', async () => {
    const { app, db, bruno, dev } = await company();
    const [lena] = await db.insert(people).values({ companyId: dev.companyId, name: 'Lena', email: 'lena@example.com', title: 'Engineer', status: 'active', scopeKind: 'company' }).returning();
    const [plan] = await db.insert(subscriptions).values({ companyId: dev.companyId, provider: 'claude', kind: 'personal', label: 'Claude', ownerPersonId: lena!.id, status: 'ready' }).returning();
    await db.update(agents).set({ subscriptionId: plan!.id }).where(eq(agents.id, bruno.id));
    const res = await call(await mcp(app), 'change_person', { person: lena!.id, status: 'disabled' });
    expect(res.isError).toBeFalsy();
    const [freed] = await db.select().from(agentChanges).where(and(eq(agentChanges.agentId, bruno.id), eq(agentChanges.field, 'subscription')));
    expect(freed).toMatchObject({ personId: null, byOrchestrator: true });
  });

  it('hands the work of an employee it switches off on in its own name', async () => {
    const { app, db, orchestrator, bruno, task } = await company();
    const res = await call(await mcp(app), 'change_employee', { employee: bruno.id, on: false });
    expect(res.isError).toBeFalsy();
    const [handed] = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id)).limit(1);
    expect(handed).toMatchObject({ text: 'Bruno was switched off.', agentId: orchestrator.id, personId: null });
  });
});


describe("the orchestrator and the company's public link", () => {
  it('takes a link, moves it to another name and removes it, as the settings do', async () => {
    const relay = await fakeRelay();
    const { app, db } = await company({ RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-link-')) });
    const client = await mcp(app);
    const taken = await call(client, 'set_public_link', { name: 'acme' });
    expect(taken.isError).toBeFalsy();
    expect(JSON.parse(text(taken))).toEqual({ link: { name: 'acme', url: 'https://acme.hornhoof.test' } });
    expect(JSON.parse(text(await call(client, 'view', { path: '/api/link' })))).toMatchObject({ link: { name: 'acme' } });
    expect(JSON.parse(text(await call(client, 'view', { path: '/api/link/names/acme-corp' })))).toEqual({ name: 'acme-corp', free: true });
    expect(JSON.parse(text(await call(client, 'set_public_link', { name: 'acme-corp' }))).link.name).toBe('acme-corp');
    expect([...relay.bindings.keys()]).toEqual(['acme-corp']);
    const random = JSON.parse(text(await call(client, 'set_public_link', {}))).link.name;
    expect(random).toMatch(/^[a-z0-9]{20,}$/);
    relay.bindings.set('globex', { key: 'k' });
    const refused = await call(client, 'set_public_link', { name: 'globex' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toBe('This link is taken already. Pick another name.');
    expect((await call(client, 'remove_public_link', {})).isError).toBeFalsy();
    expect(await db.select().from(publicLinks)).toEqual([]);
    expect([...relay.bindings.keys()]).toEqual(['globex']);
  });
});

describe('the orchestrator reads and changes the database itself', () => {
  it('reads any table and changes a field, and the map hears of the change', async () => {
    const { app, db, bruno } = await company();
    const client = await mcp(app);
    const heard: string[] = [];
    app.ctx.bus.subscribe(bruno.companyId, m => heard.push(m.type));
    const read = await call(client, 'database', { sql: `SELECT name, kind FROM agents WHERE id = '${bruno.id}'` });
    expect(read.isError).toBeFalsy();
    expect(JSON.parse(text(read))).toEqual([{ rows: [{ name: 'Bruno', kind: 'worker' }], changed: 0 }]);
    expect(heard).toEqual([]);
    const write = await call(client, 'database', { sql: `UPDATE agents SET name = 'Bruno Diaz' WHERE id = '${bruno.id}'` });
    expect(JSON.parse(text(write))).toEqual([{ rows: [], changed: 1 }]);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.name).toBe('Bruno Diaz');
    expect(heard).toEqual(['org']);
  });

  it('is refused sign-ins, invites, install codes, the public link, passwords and the tables themselves', async () => {
    const { app } = await company();
    const client = await mcp(app);
    for (const sql of ['SELECT * FROM sessions', 'SELECT * FROM invites', 'SELECT * FROM node_codes', 'SELECT * FROM public_links', "UPDATE public_links SET url = 'https://evil.test'", 'SELECT password_hash FROM people', 'DROP TABLE tasks', 'ALTER TABLE tasks ADD COLUMN x text', 'CREATE TABLE notes (id int)']) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toMatch(/permission denied|must be owner/);
    }
    expect(text(await call(client, 'database', { sql: 'SELECT * FROM sessions' }))).toContain('Sign-ins, invites, install codes and the public link are closed to this tool.');
    expect(JSON.parse(text(await call(client, 'database', { sql: 'SELECT name FROM people' })))[0].rows).toEqual([{ name: 'Ivan' }]);
  });

  it('undoes the whole call when one of its statements fails', async () => {
    const { app, db, bruno } = await company();
    const res = await call(await mcp(app), 'database', { sql: `UPDATE agents SET name = 'Nobody' WHERE id = '${bruno.id}'; SELECT * FROM sessions` });
    expect(res.isError).toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.name).toBe('Bruno');
  });

  it('cuts a long answer', async () => {
    const { app } = await company();
    const res = await call(await mcp(app), 'database', { sql: "SELECT repeat('x', 40000) AS long" });
    expect(text(res)).toMatch(/\[cut at 30000 characters\]$/);
  });

  it('says why when the database does not let Hornhoof make its role', async () => {
    const { app } = await company();
    app.ctx.agentSql = undefined;
    const res = await call(await mcp(app), 'database', { sql: 'SELECT 1' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('does not let Hornhoof');
  });

  it("keeps people, their access, an employee's kind, role and skills, a head's department and turns' tokens out of its hands, and says why", async () => {
    const { app, db, orchestrator, hana, bruno, dev, running } = await company();
    const client = await mcp(app);
    const [ivan] = await db.select().from(people);
    const [design] = await db.insert(departments).values({ companyId: bruno.companyId, templateKey: 'design', roleCode: 'DES' }).returning();
    await running(hana.id, 'tool-token-head-0123456789abcdef0123');
    const refused: [string, RegExp][] = [
      [`UPDATE people SET scope_kind = 'company', is_owner = true`, /people tools/],
      [`INSERT INTO people (company_id, name, email, status, scope_kind) VALUES ('${ivan!.companyId}', 'Eve', 'eve@test', 'active', 'company')`, /people tools/],
      [`INSERT INTO person_access (company_id, person_id, department_id) VALUES ('${ivan!.companyId}', '${ivan!.id}', '${dev.id}')`, /people tools/],
      ['DELETE FROM person_access', /people tools/],
      [`UPDATE agents SET kind = 'head' WHERE id = '${bruno.id}'`, /kind and role_key never change/],
      [`UPDATE agents SET role_key = 'OPS-HEAD' WHERE id = '${hana.id}'`, /kind and role_key never change/],
      [`UPDATE agents SET skills = '["ops-task-watch"]' WHERE id = '${bruno.id}'`, /change_employee/],
      [`UPDATE agents SET department_id = '${design!.id}' WHERE id = '${hana.id}'`, /a head stays in its department/],
      [`INSERT INTO agents (company_id, kind, name, model, role_key) VALUES ('${bruno.companyId}', 'head', 'Mole', '', 'OPS-HEAD')`, /hire/],
      [`UPDATE jobs SET tool_token_hash = 'forged' WHERE agent_id = '${orchestrator.id}'`, /tool_token_hash/],
      [`INSERT INTO jobs (company_id, subscription_id, agent_id, prompt, timeout_ms, status, tool_token_hash) SELECT company_id, subscription_id, agent_id, 'x', 1000, 'running', 'forged' FROM jobs LIMIT 1`, /tool_token_hash/],
      ['SELECT tool_token_hash FROM jobs', /tool_token_hash/],
      [`UPDATE subscriptions SET node_key_hash = 'forged'`, /node_key_hash/],
    ];
    for (const [sql, why] of refused) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toMatch(/permission denied/);
      expect(text(res), sql).toMatch(why);
    }
    expect((await db.select().from(people)).map(p => [p.scopeKind, p.isOwner])).toEqual([[ivan!.scopeKind, ivan!.isOwner]]);
    const [h, b] = [hana, bruno].map(async a => (await db.select().from(agents).where(eq(agents.id, a.id)))[0]!);
    expect(await h).toMatchObject({ kind: 'head', roleKey: 'DEV-HEAD', departmentId: dev.id });
    expect(await b).toMatchObject({ kind: 'worker', skills: bruno.skills });
    const moved = await call(client, 'database', { sql: `UPDATE agents SET department_id = '${design!.id}' WHERE id = '${bruno.id}'` });
    expect(JSON.parse(text(moved))).toEqual([{ rows: [], changed: 1 }]);
    const failed = await call(client, 'database', { sql: `UPDATE jobs SET status = 'failed', error = 'Stuck.', finished_at = now() WHERE agent_id = '${hana.id}'` });
    expect(JSON.parse(text(failed))).toEqual([{ rows: [], changed: 1 }]);
  });

  it("is the orchestrator's and the head of Operations', no one else's", async () => {
    const { app, db, hana, bruno, running } = await company();
    const wanda = await opsHead(db, bruno);
    const tokens = { bruno: WORKER_TOKEN, hana: 'tool-token-head-0123456789abcdef0123', wanda: OPS_TOKEN };
    await running(bruno.id, tokens.bruno);
    await running(hana.id, tokens.hana);
    await running(wanda.id, tokens.wanda);
    const has = async (token: string) => (await (await mcp(app, token)).listTools()).tools.some(t => t.name === 'database');
    expect([await has(tokens.bruno), await has(tokens.hana), await has(tokens.wanda)]).toEqual([false, false, true]);
    const read = await call(await mcp(app, tokens.wanda), 'database', { sql: `SELECT name FROM agents WHERE id = '${bruno.id}'` });
    expect(JSON.parse(text(read))).toEqual([{ rows: [{ name: 'Bruno' }], changed: 0 }]);
  });

  it('lets the head of Operations read, but nothing hidden or secret, and change nothing', async () => {
    const { app, db, bruno, task, running } = await company();
    const wanda = await opsHead(db, bruno);
    await running(wanda.id, OPS_TOKEN);
    const client = await mcp(app, OPS_TOKEN);
    const writes = [
      `UPDATE agents SET name = 'Bruno Diaz' WHERE id = '${bruno.id}'`,
      `UPDATE people SET scope_kind = 'company'`,
      `DELETE FROM tasks WHERE id = '${task.id}'`,
      `INSERT INTO companies (name) VALUES ('Other')`,
      `SET TRANSACTION READ WRITE; UPDATE agents SET name = 'Bruno Diaz' WHERE id = '${bruno.id}'`,
      'CREATE TABLE notes (id int)',
    ];
    for (const sql of writes) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toContain('Operations reads the database; a change goes to the orchestrator as one message with the SQL and why.');
    }
    for (const sql of ['SELECT * FROM sessions', 'SELECT * FROM invites', 'SELECT * FROM node_codes', 'SELECT * FROM public_links', 'SELECT password_hash FROM people', 'SELECT tool_token_hash FROM jobs', 'SELECT * FROM jobs']) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toMatch(/closed to this tool/);
      expect(text(res), sql).not.toContain('Operations reads the database');
    }
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.name).toBe('Bruno');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id))).length).toBe(1);
    const read = await call(client, 'database', { sql: `SELECT status, error FROM jobs WHERE agent_id = '${wanda.id}'` });
    expect(JSON.parse(text(read))).toEqual([{ rows: [{ status: 'running', error: null }], changed: 0 }]);
  });
});

const OPS_TOKEN = 'tool-token-ops-0123456789abcdef01234';

/* Wanda, the head of a new Operations department, on Bruno's subscription. */
async function opsHead(db: Awaited<ReturnType<typeof company>>['db'], bruno: Awaited<ReturnType<typeof company>>['bruno']) {
  const [ops] = await db.insert(departments).values({ companyId: bruno.companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
  return (await db.insert(agents).values({ companyId: bruno.companyId, kind: 'head', name: 'Wanda', roleKey: 'OPS-HEAD', departmentId: ops!.id, model: '', subscriptionId: bruno.subscriptionId }).returning())[0]!;
}
