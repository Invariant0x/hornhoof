import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, desc, eq, isNull, like } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { NotConfirmed } from '../src/db/confirm.js';
import { agentChanges, agentEvents, agents, companies, departments, jobs, machines, people, proposals, publicLinks, requests, subscriptions, taskEvents, tasks, teams } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { ask, createTask, submit } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { fakeRelay } from './fake-relay.js';
import { as, connectNode, invitePerson, listen, mcp, setUpCompany, testApp, until, takePlan, echelonsTurn } from './helpers.js';
import { said } from '../src/modules/conversation/live.js';
import { BUILTIN } from './builtin.js';

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
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null, null, BUILTIN)!));
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const running = (agentId: string, token: string, answersCeo = false, createdBy: string | null = null) =>
    db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', toolTokenHash: hashToken(token), answersCeo, createdBy }).returning();
  /* The orchestrator's turn is the CEO's, who started it without a message, so every tool works in it. */
  await running(orchestrator!.id, TOKEN, true, owner!.id);
  await echelonsTurn(db, acme!.id);
  const task = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code' })).task;
  return { app, db, ceo, ceoId: owner!.id, orchestrator: orchestrator!, hana, bruno, dev: dev!, task, running };
}


type Result = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as Result;
const text = (res: Result) => res.content[0]!.text;

describe('the orchestrator runs the company as the CEO can in Hornhoof', () => {
  it.each([
    ['change_employee', "null for its role's level"],
    ['change_orchestrator', 'null for xhigh'],
    ['reset_employee', 'its skills, texts and effort'],
  ])('describes the role effort in %s', async (name, words) => {
    const { app } = await company();
    const tools = (await (await mcp(app, TOKEN)).listTools()).tools;
    expect(tools.find(t => t.name === name)!.description).toContain(words);
  });

  it("sets an employee's timer and takes it away", async () => {
    const { app, db, bruno } = await company();
    const client = await mcp(app, TOKEN);
    const set = await call(client, 'change_employee', { employee: bruno.id, timer: { minutes: 60, order: 'Read the failed jobs of the last hour.' } });
    expect(set.isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]).toMatchObject({ timerMinutes: 60, timerOrder: 'Read the failed jobs of the last hour.' });
    await call(client, 'change_employee', { employee: bruno.id, timer: null });
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.timerMinutes).toBeNull();
  });

  it('changes its own effort as its card does, and keeps to what the card changes', async () => {
    const { app, db, orchestrator } = await company();
    const client = await mcp(app, TOKEN);
    expect((await call(client, 'change_orchestrator', { effort: 'high' })).isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, orchestrator.id)))[0]!.effort).toBe('high');
    const changes = await db.select().from(agentChanges).where(eq(agentChanges.agentId, orchestrator.id));
    expect(changes.map(c => [c.field, c.after, c.byOrchestrator])).toEqual([['effort', 'high', true]]);
    expect((await call(client, 'change_orchestrator', { effort: 'loud' })).isError).toBe(true);
  });

  it('switches an employee off and on, and the card says the orchestrator did it', async () => {
    const { app, db, ceo, bruno } = await company();
    const client = await mcp(app, TOKEN);
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
    const res = await call(await mcp(app, TOKEN), 'fire_employee', { employee: orchestrator.id });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('The orchestrator stays with the company.');
  });

  it('writes to an employee as itself', async () => {
    const { app, db, bruno, orchestrator } = await company();
    const res = await call(await mcp(app, TOKEN), 'message_employee', { employee: bruno.id, text: 'Please look at the checkout bug first.' });
    expect(res.isError).toBeFalsy();
    const [turn] = await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), isNull(jobs.taskId)));
    expect(turn!.prompt).toBe(
      'From Orchestrator to Bruno (Backend engineer, Development):\n\nOrchestrator: Please look at the checkout bug first.' +
        `\n\nIf you answer Orchestrator, do it with "message_employee", employee ${orchestrator.id}: an answer in this window does not reach Orchestrator.`,
    );
    expect(turn!.createdBy).toBeNull();
    const [said] = await db.select().from(agentEvents).where(eq(agentEvents.agentId, bruno.id));
    expect(said).toMatchObject({ kind: 'message', personId: null, data: { text: 'Please look at the checkout bug first.', from: 'orchestrator' } });
  });

  it("lends one of the company's machines to test runs or takes it back, as the machines screen does", async () => {
    const { app, db } = await company();
    const [acme] = await db.select().from(companies);
    const [ivan] = await db.select().from(people);
    const [machine] = await db.insert(machines).values({ companyId: acme!.id, personId: ivan!.id, machineKey: 'mac-0001-abcd', hostname: 'dev-mac' }).returning();
    const client = await mcp(app, TOKEN);
    expect(text(await call(client, 'lend_machine', { machine: machine!.id, lendsTests: false }))).toContain('"lendsTests":false');
    expect((await db.select().from(machines))[0]!.lendsTests).toBe(false);
  });

  it('reads any page the CEO can open', async () => {
    const { app } = await company();
    const res = await call(await mcp(app, TOKEN), 'view', { path: '/api/people' });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text(res)).people[0]).toMatchObject({ title: 'CEO' });
    expect((await call(await mcp(app, TOKEN), 'view', { path: '/mcp' })).isError).toBe(true);
  });

  it("shows the CEO alone, in this window, the commands that connect the CEO's machines and plans, and never the orchestrator", async () => {
    const { app, db, ceo } = await company();
    const client = await mcp(app, TOKEN);
    const SHOWN = 'The command is shown to the CEO in this window; it works once, for 24 hours.';
    const commands = async () => (await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands as { id: string; command: string }[];
    const code = (command: string) => command.split('--join ')[1]!;
    const machine = { machineId: 'laptop-0002-abcd', hostname: 'dev-laptop', os: 'linux', arch: 'x86_64' };

    expect(text(await call(client, 'machine_command', {}))).toBe(SHOWN);
    const [alone] = await commands();
    expect(alone).toMatchObject({ kind: 'machine', plans: [], machine: null, expiresAt: expect.any(String) });
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: code(alone!.command), ...machine } })).json();
    expect(joined.nodes).toMatchObject([{ subscriptionId: null, provider: 'machine' }]);
    expect(await commands()).toEqual([]);

    expect(text(await call(client, 'connect_plans', { providers: ['claude'] }))).toBe(SHOWN);
    const [plan] = await db.select().from(subscriptions).where(eq(subscriptions.provider, 'claude'));
    expect((await call(client, 'plan_command', { subscription: plan!.id })).isError).toBe(true);
    expect(text(await call(client, 'add_plan_to_machine', { machine: joined.machine.id, subscription: plan!.id }))).toBe(SHOWN);
    const made = await commands();
    expect(made).toMatchObject([
      { kind: 'plans', plans: ['Claude'], machine: null },
      { kind: 'add', plans: ['Claude'], machine: 'dev-laptop' },
    ]);
    const there = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: code(made[1]!.command), ...machine } })).json();
    expect(there.nodes).toMatchObject([{ subscriptionId: plan!.id, provider: 'claude' }]);

    expect((await app.inject({ method: 'POST', url: `/api/nodes/commands/${made[0]!.id}/hide`, ...as(ceo) })).statusCode).toBe(204);
    expect(await commands()).toMatchObject([{ id: made[0]!.id, dismissedSubscriptionIds: [plan!.id] }]);
    expect((await call(client, 'view', { path: '/api/nodes/commands' })).isError).toBe(true);
    const events = JSON.stringify(await db.select(only(agentEvents, 'data')).from(agentEvents));
    for (const c of [alone!, ...made]) expect(events).not.toContain(code(c.command));
  });

  it("keeps a machine's command from the people who did not get it, and from the orchestrator's own calls", async () => {
    const { app, db, ceo, orchestrator } = await company();
    await call(await mcp(app, TOKEN), 'machine_command', {});
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    expect((await app.inject({ url: '/api/nodes/commands', ...as(maria) })).json().commands).toEqual([]);
    const [ivan] = await db.select().from(people).where(eq(people.isOwner, true));
    const inside = await app.inject({ url: '/api/nodes/commands', headers: orchestratorHeaders(ivan!.id, orchestrator.id) });
    expect(inside.statusCode).toBe(403);
    const [made] = (await app.inject({ url: '/api/nodes/commands', ...as(ceo) })).json().commands;
    expect((await app.inject({ method: 'POST', url: `/api/nodes/commands/${made.id}/hide`, ...as(maria) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/nodes/commands/${made.id}/hide`, headers: orchestratorHeaders(ivan!.id, orchestrator.id) })).statusCode).toBe(403);
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
    const res = await call(await mcp(app, TOKEN), 'message_employee', { employee: orchestrator.id, text: 'Remember to check the tests.' });
    expect(res.isError).toBe(true);
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), eq(jobs.status, 'queued')))).toEqual([]);
  });

  it('cancels a task that someone else gave', async () => {
    const { app, db, task } = await company();
    const res = await call(await mcp(app, TOKEN), 'cancel_task', { task: task.number, why: 'The CEO dropped checkout.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('cancelled');
  });

  it('rewrites any task', async () => {
    const { app, db, task } = await company();
    const res = await call(await mcp(app, TOKEN), 'update_task', { task: task.number, body: 'POST /checkout with tax.' });
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
    const res = await call(await mcp(app, TOKEN), 'build_structure', { items: [{ template: 'design', note: 'Screens for checkout.' }] });
    expect(res.isError).toBeFalsy();
    expect(await db.select().from(departments).where(eq(departments.templateKey, 'design'))).toHaveLength(1);
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), like(jobs.prompt, 'Hornhoof applied%')))).toEqual([]);
    const [applied] = await db.select().from(agentEvents).where(and(eq(agentEvents.agentId, orchestrator.id), eq(agentEvents.kind, 'applied')));
    expect(applied!.personId).toBeNull();
  });

  it('builds a department with the people of its template, and one without them only when told so', async () => {
    const { app, db } = await company();
    const client = await mcp(app, TOKEN);
    expect((await call(client, 'build_structure', { items: [{ template: 'design', note: '' }] })).isError).toBeFalsy();
    expect((await call(client, 'build_structure', { items: [{ template: 'finance', note: '', staff: false }] })).isError).toBeFalsy();
    const [design] = await db.select().from(departments).where(eq(departments.templateKey, 'design'));
    const [finance] = await db.select().from(departments).where(eq(departments.templateKey, 'finance'));
    const roster = app.ctx.templates.roster('design').filter(r => r.inDefault).map(r => r.id);
    const people = await db.select().from(agents).where(and(eq(agents.departmentId, design!.id), isNull(agents.teamId)));
    expect(people.map(a => a.roleKey).sort()).toEqual(roster.sort());
    expect(people.every(a => a.skills.length > 0)).toBe(true);
    expect(await db.select().from(agents).where(eq(agents.departmentId, finance!.id))).toEqual([]);
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
    expect((await call(await mcp(app, TOKEN), 'explain_request', { request: request.id, text: plain })).isError).toBeFalsy();
    const listed = (await app.inject({ url: '/api/requests', ...as(ceo) })).json().requests;
    expect(listed).toMatchObject([{ id: request.id, explained: plain, explaining: false }]);
    /* People answer; only the orchestrator puts a request into words. */
    const byPerson = await app.inject({ method: 'POST', url: `/api/requests/${request.id}/explained`, payload: { text: 'x' }, ...as(ceo) });
    expect(byPerson.statusCode).toBe(403);
  });

  it('answers an employee\'s question as itself, for the CEO its turn answers', async () => {
    const { app, db, ceoId, orchestrator, bruno, task } = await company();
    const { request } = await ask(app.ctx, bruno.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    const res = await call(await mcp(app, TOKEN), 'answer_request', { request: request.id, answer: 'Yes, with tax.' });
    expect(res.isError).toBeFalsy();
    const [job] = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id));
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]).toMatchObject({ status: 'answered', answeredBy: ceoId, answeredByAgentId: orchestrator.id, answerJobId: job!.id, answerSourceSeq: null });
    const [said] = await db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'answered')));
    expect(said).toMatchObject({ personId: null, agentId: orchestrator.id, data: { onBehalfOfPersonId: ceoId, jobId: job!.id, sourceSeq: null } });
  });

  it('hires with what the card starts with and is not woken about it', async () => {
    const { app, db, orchestrator, dev } = await company();
    const res = await call(await mcp(app, TOKEN), 'hire', { department: dev.id, people: [{ role: 'DEV-QA' }] });
    expect(res.isError).toBeFalsy();
    const [qa] = await db.select().from(agents).where(eq(agents.roleKey, 'DEV-QA'));
    const role = app.ctx.templates.roles.get('DEV-QA')!;
    /* No model was named, so it runs the one its role asks for on its plan, by name: the middle one of the company's key. */
    expect(qa).toMatchObject({ name: role.title.en, model: 'claude-sonnet-5-5', createdBy: null, skills: role.skills.filter(s => s.on).map(s => s.id) });
    expect(qa!.subscriptionId).not.toBeNull();
    const [hired] = await db.select().from(agentChanges).where(eq(agentChanges.agentId, qa!.id));
    expect(hired).toMatchObject({ field: 'hired', personId: null, byOrchestrator: true });
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, orchestrator.id), like(jobs.prompt, 'Hornhoof applied%')))).toEqual([]);
  });

  it('keeps a task nobody holds blocked when it rewrites it', async () => {
    const { app, db, orchestrator, hana, dev } = await company();
    const payments = (await createTask(app.ctx, { agentId: orchestrator.id }, { title: 'Payments', brief: '', body: '', departmentId: dev.id, assigneeAgentId: hana.id })).task;
    await db.update(tasks).set({ status: 'blocked', assigneeAgentId: null }).where(eq(tasks.id, payments.id));
    const res = await call(await mcp(app, TOKEN), 'update_task', { task: payments.number, body: 'Payments with tax.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, payments.id)))[0]).toMatchObject({ body: 'Payments with tax.', status: 'blocked' });
  });

  it('lets the orchestrator assign an eligible checker without skipping the required Review', async () => {
    const { app, db, hana, bruno, dev } = await company();
    await db.update(departments).set({ repoUrl: 'https://github.com/acme/shop.git' }).where(eq(departments.id, dev.id));
    await db.update(agents).set({ model: 'claude-opus-5-5' }).where(eq(agents.id, bruno.id));
    const reviewers = await db.insert(agents).values(['Rita', 'Rob'].map(name => ({ companyId: dev.companyId, kind: 'worker' as const, name, roleKey: 'DEV-REV', departmentId: dev.id, model: 'claude-opus-5-5', subscriptionId: bruno.subscriptionId, skills: app.ctx.templates.roles.get('DEV-REV')!.skills.filter(s => s.on).map(s => s.id) }))).returning();
    const [rita, rob] = reviewers;
    app.ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
    app.ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
    const checked = (await createTask(app.ctx, { agentId: hana.id }, { title: 'Refunds', brief: '', body: '', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId: rita!.id })).task;
    const submitted = await submit(app.ctx, bruno.id, checked.id, { summary: 'Ready.', evidence: 'Changed total tests.', review: { baseCommit: BASE } });
    const candidateId = (await routeOf(db, submitted.task)).state.candidateId;
    const res = await call(await mcp(app, TOKEN), 'update_task', { task: checked.number, ownerAgentId: rob!.id });
    expect(res.isError, text(res)).toBeFalsy();
    const [current] = await db.select().from(tasks).where(eq(tasks.id, checked.id));
    expect(current).toMatchObject({ status: 'review', assigneeAgentId: rob!.id, executorAgentId: bruno.id });
    expect(routeSnapshot(await routeOf(db, current!), current!.assigneeAgentId)).toMatchObject({ stage: 'review', phase: 'active', candidateId, ownerAgentId: rob!.id });
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, rob!.id), eq(jobs.taskId, checked.id)))).toHaveLength(1);
  });

  it('closes the staff card it hires from', async () => {
    const { app, db, dev } = await company();
    const client = await mcp(app, TOKEN);
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
    const res = await call(await mcp(app, TOKEN), 'change_person', { person: lena!.id, status: 'disabled' });
    expect(res.isError).toBeFalsy();
    const [freed] = await db.select().from(agentChanges).where(and(eq(agentChanges.agentId, bruno.id), eq(agentChanges.field, 'subscription')));
    expect(freed).toMatchObject({ personId: null, byOrchestrator: true });
  });

  it('hands the work of an employee it switches off on in its own name', async () => {
    const { app, db, orchestrator, bruno, task } = await company();
    const res = await call(await mcp(app, TOKEN), 'change_employee', { employee: bruno.id, on: false });
    expect(res.isError).toBeFalsy();
    const [handed] = await db.select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).orderBy(desc(taskEvents.id)).limit(1);
    expect(handed).toMatchObject({ kind: 'updated', text: 'Bruno left the assignment.', agentId: orchestrator.id, personId: null, data: { fields: ['owner'] } });
    const [current] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(current).toMatchObject({ status: 'waiting', assigneeAgentId: null, executorAgentId: bruno.id });
    expect(routeSnapshot(await routeOf(db, current!), current!.assigneeAgentId)).toMatchObject({ stage: 'architecture', phase: 'waiting', ownerAgentId: null });
  });

  it('creates, renames and deletes a sub-unit and moves an employee into it and back, from the screen and with its tools', async () => {
    const { app, db, ceo, bruno, dev } = await company();
    const client = await mcp(app, TOKEN);

    const built = await call(client, 'build_structure', { items: [{ department: dev.id, note: '', teams: ['Urgent fixes'] }] });
    expect(built.isError).toBeFalsy();
    const [urgent] = await db.select().from(teams).where(eq(teams.departmentId, dev.id));
    expect(urgent).toMatchObject({ name: 'Urgent fixes', stage: 0, gate: false });

    const movedIn = await call(client, 'change_employee', { employee: bruno.id, team: urgent!.id });
    expect(movedIn.isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.teamId).toBe(urgent!.id);

    const renamed = await call(client, 'build_structure', { items: [{ department: dev.id, note: '', teams: [{ id: urgent!.id, name: 'Hotfixes' }] }] });
    expect(renamed.isError).toBeFalsy();
    expect((await db.select().from(teams).where(eq(teams.id, urgent!.id)))[0]!.name).toBe('Hotfixes');

    const movedOut = await call(client, 'change_employee', { employee: bruno.id, team: null });
    expect(movedOut.isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.teamId).toBeNull();

    const screenCreated = await app.inject({ method: 'POST', url: `/api/departments/${dev.id}/teams`, payload: { name: 'Labs' }, ...as(ceo) });
    expect(screenCreated.statusCode).toBe(201);
    const labsId = screenCreated.json().team.id as string;

    const screenMoved = await app.inject({ method: 'PATCH', url: `/api/agents/${bruno.id}`, payload: { team: labsId }, ...as(ceo) });
    expect(screenMoved.statusCode).toBe(200);
    expect(screenMoved.json().team).toEqual({ id: labsId, name: 'Labs' });

    const screenRenamed = await app.inject({ method: 'PATCH', url: `/api/departments/${dev.id}/teams/${labsId}`, payload: { name: 'R&D' }, ...as(ceo) });
    expect(screenRenamed.statusCode).toBe(200);
    expect(screenRenamed.json().team.name).toBe('R&D');

    const screenDeleted = await app.inject({ method: 'DELETE', url: `/api/departments/${dev.id}/teams/${labsId}`, ...as(ceo) });
    expect(screenDeleted.statusCode).toBe(204);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.teamId).toBeNull();

    const toolDeleted = await call(client, 'build_structure', { items: [{ department: dev.id, note: '', teams: [{ id: urgent!.id, remove: true }] }] });
    expect(toolDeleted.isError).toBeFalsy();
    expect(await db.select().from(teams).where(eq(teams.departmentId, dev.id))).toEqual([]);
  });
});


describe("the orchestrator and the company's public link", () => {
  it('takes a link, moves it to another name and removes it, as the settings do', async () => {
    const relay = await fakeRelay();
    const { app, db } = await company({ RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-link-')) });
    const client = await mcp(app, TOKEN);
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
    const client = await mcp(app, TOKEN);
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

  it('stays out of the merge records', async () => {
    const { app } = await company();
    const client = await mcp(app, TOKEN);
    for (const table of ['net.merges', 'net.merge_rows', 'net.merge_conflicts']) {
      const res = await call(client, 'database', { sql: `SELECT * FROM ${table}` });
      expect(res.isError, table).toBe(true);
      expect(text(res), table).toMatch(/permission denied/);
    }
  });

  it('stays out of the ranking', async () => {
    const { app } = await company();
    const client = await mcp(app, TOKEN);
    const res = await call(client, 'database', { sql: 'SELECT * FROM net.ranking' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/permission denied/);
  });

  it('stays out of the pulse', async () => {
    const { app } = await company();
    const client = await mcp(app, TOKEN);
    const res = await call(client, 'database', { sql: 'SELECT * FROM net.pulse' });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/permission denied/);
  });

  it('is refused sign-ins, invites, install codes, the public link, passwords and the tables themselves', async () => {
    const { app } = await company();
    const client = await mcp(app, TOKEN);
    /* The tool refuses every statement here, so none changes the database this file shares. */
    // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- The agent's statements are refused, and the file's end check would find one that was not.
    for (const sql of ['SELECT * FROM sessions', 'SELECT * FROM invites', 'SELECT * FROM node_codes', 'SELECT * FROM public_links', "UPDATE public_links SET url = 'https://evil.test'", 'SELECT * FROM sign_in_attempts', 'SELECT * FROM link_tls', 'SELECT * FROM plan_credentials', "DELETE FROM plan_credentials", 'SELECT * FROM authority', 'SELECT * FROM certificates', 'SELECT * FROM peer_secrets', 'SELECT * FROM machine_tickets', 'SELECT * FROM machine_online', 'SELECT * FROM person_keys', 'SELECT * FROM machine_access', "UPDATE machine_access SET until = now() + interval '1 day'", 'SELECT * FROM computer_runs', 'SELECT * FROM recovery_keys', 'SELECT * FROM net.backups', "UPDATE machines SET role = 'data'", 'SELECT account FROM nodes', 'SELECT password_hash FROM people', 'DROP TABLE tasks', 'ALTER TABLE tasks ADD COLUMN x text', 'CREATE TABLE notes (id int)']) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toMatch(/permission denied|must be owner|Hornhoof did not run this SQL/);
    }
    expect(text(await call(client, 'database', { sql: 'SELECT * FROM sessions' }))).toContain("Sign-ins, invites, install codes, sealed plan sign-ins, the public link, Hornhoof's records of where changes came from, the company's certificate authority, its machines' certificates and the peer secrets, the machines' join tickets and online time, people's keys, the machines' computer access and the commands run there, and the recovery keys are closed to this tool.");
    expect(JSON.parse(text(await call(client, 'database', { sql: 'SELECT name FROM people' })))[0].rows).toEqual([{ name: 'Ivan' }]);
    expect(JSON.parse(text(await call(client, 'database', { sql: 'SELECT cause FROM node_connections' })))[0].rows).toEqual([]);
  });

  it('refuses SQL that would get past a fence', async () => {
    const { app, db } = await company();
    const client = await mcp(app, TOKEN);
    const before = await db.select({ id: agents.id, name: agents.name }).from(agents);
    for (const sql of ['COMMIT', 'SET LOCAL synchronous_commit = local; UPDATE agents SET name = name', 'SELECT pg_cancel_backend(1)', 'SELECT 1; SET CONSTRAINTS ALL IMMEDIATE', "COMMIT; UPDATE agents SET name = 'Gone'"]) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toContain('Hornhoof did not run this SQL:');
    }
    expect(await db.select({ id: agents.id, name: agents.name }).from(agents)).toEqual(before);
  });

  it('answers in five seconds', async () => {
    const { app } = await company();
    const tools = (await (await mcp(app, TOKEN)).listTools()).tools;
    expect(tools.find(t => t.name === 'database')!.description).toContain('a call may take 5 seconds');
  });

  it('says the call may have run when the database could not confirm it', async () => {
    const { app } = await company();
    const client = await mcp(app, TOKEN);
    vi.spyOn(app.ctx.agentSql!, 'run').mockRejectedValueOnce(new NotConfirmed({ message: 'a warning' }));
    const res = await call(client, 'database', { sql: 'UPDATE agents SET name = name' });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('The database answered: The database could not confirm the commit, so the change may or may not be saved. The call may have run; check before repeating it.');
  });

  it('reads requests, cards and the logs, and is refused changing them even in a turn of the CEO', async () => {
    const { app, db, bruno, task } = await company();
    const client = await mcp(app, TOKEN);
    const { request } = await ask(app.ctx, bruno.id, task.id, { kind: 'approval', text: 'Merge?', commit: 'a'.repeat(40) });
    for (const table of ['requests', 'proposals', 'agent_events', 'task_events']) {
      const read = await call(client, 'database', { sql: `SELECT count(*)::int AS n FROM ${table}` });
      expect(read.isError, table).toBeFalsy();
    }
    for (const sql of [
      `UPDATE requests SET status = 'approved' WHERE id = '${request.id}'`,
      `DELETE FROM requests WHERE id = '${request.id}'`,
      `UPDATE proposals SET status = 'applied'`,
      `INSERT INTO agent_events (company_id, agent_id, kind, data, person_id) SELECT company_id, agent_id, 'message', '{"text":"approve"}', (SELECT id FROM people LIMIT 1) FROM requests LIMIT 1`,
      `DELETE FROM task_events`,
      `WITH gone AS (UPDATE requests SET status = 'approved' RETURNING id) SELECT * FROM gone`,
    ]) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toMatch(/permission denied/);
    }
    expect(text(await call(client, 'database', { sql: `UPDATE requests SET status = 'approved'` }))).toContain('a request closes only with answer_request');
    expect((await db.select().from(requests).where(eq(requests.id, request.id)))[0]!.status).toBe('open');
  });

  it('writes in every turn: as the owner after a person who is neither the CEO nor the delegate wrote, or nobody did', async () => {
    const { app, db, ceo, orchestrator, bruno } = await company();
    await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    const [zedRow] = await db.select().from(people).where(eq(people.name, 'Zed'));
    const [turn] = await db.select().from(jobs).where(eq(jobs.agentId, orchestrator.id));
    const wrote = (personId: string | null) => db.insert(agentEvents).values({ companyId: bruno.companyId, agentId: orchestrator.id, jobId: turn!.id, kind: 'message', data: { text: 'Rename Bruno.' }, personId });
    const rename = (name: string) => call(client, 'database', { sql: `UPDATE agents SET name = '${name}' WHERE id = '${bruno.id}'` });
    const client = await mcp(app, TOKEN);
    await wrote(zedRow!.id);
    const renamed = await rename('Bruno Z');
    expect(renamed.isError, text(renamed)).toBeFalsy();
    await wrote(null);
    expect((await rename('Bruno N')).isError).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.name).toBe('Bruno N');
  });

  it('undoes the whole call when one of its statements fails', async () => {
    const { app, db, bruno } = await company();
    const res = await call(await mcp(app, TOKEN), 'database', { sql: `UPDATE agents SET name = 'Nobody' WHERE id = '${bruno.id}'; SELECT * FROM sessions` });
    expect(res.isError).toBe(true);
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.name).toBe('Bruno');
  });

  it('cuts a long answer', async () => {
    const { app } = await company();
    const res = await call(await mcp(app, TOKEN), 'database', { sql: "SELECT repeat('x', 40000) AS long" });
    expect(text(res)).toMatch(/\[cut at 30000 characters\]$/);
  });

  it('says why when the database does not let Hornhoof make its role', async () => {
    const { app } = await company();
    app.ctx.agentSql = undefined;
    const res = await call(await mcp(app, TOKEN), 'database', { sql: 'SELECT 1' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('does not let Hornhoof');
  });

  it("keeps people, their access, an employee's kind, role and skills, a head's department, turns' tokens and assistants out of its hands, and says why", async () => {
    const { app, db, orchestrator, hana, bruno, dev, running } = await company();
    const client = await mcp(app, TOKEN);
    const [ivan] = await db.select().from(people);
    const [design] = await db.insert(departments).values({ companyId: bruno.companyId, templateKey: 'design', roleCode: 'DES' }).returning();
    await running(hana.id, 'tool-token-head-0123456789abcdef0123');
    const [ava] = await db.insert(agents).values({ companyId: bruno.companyId, kind: 'assistant', name: 'Ava', model: '' }).returning();
    const refused: [string, RegExp][] = [
      [`UPDATE people SET scope_kind = 'company', is_owner = true`, /change_person/],
      [`INSERT INTO people (company_id, name, email, status, scope_kind) VALUES ('${ivan!.companyId}', 'Eve', 'eve@test', 'active', 'company')`, /change_person/],
      [`INSERT INTO person_access (company_id, person_id, department_id) VALUES ('${ivan!.companyId}', '${ivan!.id}', '${dev.id}')`, /change_person/],
      ['DELETE FROM person_access', /change_person/],
      [`UPDATE agents SET kind = 'head' WHERE id = '${bruno.id}'`, /kind and role_key never change/],
      [`UPDATE agents SET role_key = 'OPS-HEAD' WHERE id = '${hana.id}'`, /kind and role_key never change/],
      [`UPDATE agents SET skills = '["ops-task-watch"]' WHERE id = '${bruno.id}'`, /change_employee/],
      [`UPDATE agents SET department_id = '${design!.id}' WHERE id = '${hana.id}'`, /a head stays in its department/],
      [`INSERT INTO agents (company_id, kind, name, model, role_key) VALUES ('${bruno.companyId}', 'head', 'Mole', '', 'OPS-HEAD')`, /hire/],
      [`UPDATE jobs SET tool_token_hash = 'forged' WHERE agent_id = '${orchestrator.id}'`, /tool_token_hash/],
      [`INSERT INTO jobs (company_id, subscription_id, agent_id, prompt, timeout_ms, status, tool_token_hash) SELECT company_id, subscription_id, agent_id, 'x', 1000, 'running', 'forged' FROM jobs LIMIT 1`, /tool_token_hash/],
      ['SELECT tool_token_hash FROM jobs', /tool_token_hash/],
      [`UPDATE nodes SET key_hash = 'forged'`, /key_hash/],
      ['SELECT key_hash FROM nodes', /key_hash/],
      ['SELECT machine_key FROM machines', /machine_key/],
      [`UPDATE machines SET machine_key = 'taken-0001-abcd'`, /machine_key/],
      [`UPDATE nodes SET status = 'ready'`, /only the CEO/],
      ['UPDATE subscriptions SET budget = 10', /only the CEO/],
      ['UPDATE machines SET revoked_at = now()', /only the CEO/],
      ['UPDATE machines SET lends_tests = false', /only the CEO/],
      ['DELETE FROM node_connections', /Hornhoof writes the history/],
      [`UPDATE node_connections SET cause = 'network'`, /Hornhoof writes the history/],
      ['DELETE FROM test_parts', /run_tests/],
      ['DELETE FROM harness_builds', /test_harness/],
      [`UPDATE harness_products SET told = 'quiet'`, /test_harness/],
      [`UPDATE departments SET repo_url = 'https://evil.test/acme.git' WHERE id = '${dev.id}'`, /only on its screen or with set_repository, on the word of the CEO or a person who runs it/],
      [`UPDATE agents SET subscription_id = NULL WHERE id = '${orchestrator.id}'`, /change_employee/],
      [`UPDATE agents SET node_id = NULL WHERE id = '${bruno.id}'`, /change_employee/],
      [`UPDATE agents SET name = 'Ivy' WHERE id = '${ava!.id}'`, /an assistant's own agent belongs to its owner/],
      [`UPDATE agents SET removed_at = now() WHERE id = '${ava!.id}'`, /an assistant's own agent belongs to its owner/],
      [`UPDATE assistants SET events_url = 'https://evil.test/'`, /People screen/],
      [`UPDATE assistants SET key_hash = 'forged'`, /key_hash/],
      ['SELECT key_hash FROM assistants', /key_hash/],
      ['SELECT wake_secret_enc FROM assistants', /wake_secret_enc/],
      ['DELETE FROM assistant_events', /only reads/],
      ['UPDATE assistant_replies SET answered = true', /only reads/],
      [`UPDATE agent_inbox SET sender_name = 'Ivan'`, /inbox_mark/],
      ['DELETE FROM agent_inbox', /inbox_mark/],
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
      // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- The reader's statements are refused, and the file's end check would find one that was not.
      'CREATE TABLE notes (id int)',
    ];
    for (const sql of writes) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toContain('Operations reads the database; a change goes to the orchestrator as one message with the SQL and why.');
    }
    for (const sql of ['SELECT * FROM sessions', 'SELECT * FROM invites', 'SELECT * FROM node_codes', 'SELECT * FROM public_links', 'SELECT password_hash FROM people', 'SELECT tool_token_hash FROM jobs', 'SELECT * FROM jobs', 'SELECT key_hash FROM nodes', 'SELECT account FROM nodes', 'SELECT * FROM sign_in_attempts', 'SELECT * FROM link_tls', 'SELECT * FROM plan_credentials', 'SELECT machine_key FROM machines', 'SELECT * FROM machines']) {
      const res = await call(client, 'database', { sql });
      expect(res.isError, sql).toBe(true);
      expect(text(res), sql).toMatch(/closed to this tool/);
      expect(text(res), sql).not.toContain('Operations reads the database');
    }
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.name).toBe('Bruno');
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id))).length).toBe(1);
    expect(JSON.parse(text(await call(client, 'database', { sql: 'SELECT cause FROM node_connections' })))[0].rows).toEqual([]);
    const read = await call(client, 'database', { sql: `SELECT status, error FROM jobs WHERE agent_id = '${wanda.id}'` });
    expect(JSON.parse(text(read))).toEqual([{ rows: [{ status: 'running', error: null }], changed: 0 }]);
  });
});

describe('what the CEO may ask for, which the orchestrator does in any turn as the owner', () => {
  const HEAD_TOKEN = 'tool-token-head-0123456789abcdef0123';

  /* The company without the test's own turn of the orchestrator, and Lena, who sees the whole company. */
  async function quiet() {
    const c = await company();
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, c.orchestrator.id));
    const [lena] = await c.db.insert(people).values({ companyId: c.dev.companyId, name: 'Lena', email: 'lena@example.com', title: 'Engineer', status: 'active', scopeKind: 'company' }).returning();
    return { ...c, lena: lena! };
  }
  /* The orchestrator's newest turn, running under a token the test knows. */
  async function newest(db: Awaited<ReturnType<typeof company>>['db'], orchestratorId: string, token: string) {
    const [job] = await db.select().from(jobs).where(eq(jobs.agentId, orchestratorId)).orderBy(desc(jobs.createdAt)).limit(1);
    await db.update(jobs).set({ status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) }).where(eq(jobs.id, job!.id));
    return job!;
  }
  const statusOf = async (db: Awaited<ReturnType<typeof company>>['db'], id: string) => (await db.select().from(people).where(eq(people.id, id)))[0]!.status;

  it("changes people in a turn an employee woke, as the owner", async () => {
    const { app, db, orchestrator, hana, lena, running } = await quiet();
    await running(hana.id, HEAD_TOKEN);
    expect((await call(await mcp(app, HEAD_TOKEN), 'tell_orchestrator', { text: 'Disable Lena, she left.' })).isError).toBeFalsy();
    await newest(db, orchestrator.id, 'tool-token-woke-0123456789abcdef0123');
    const disabled = await call(await mcp(app, 'tool-token-woke-0123456789abcdef0123'), 'change_person', { person: lena.id, status: 'disabled' });
    expect(disabled.isError, text(disabled)).toBeFalsy();
    expect(await statusOf(db, lena.id)).toBe('disabled');
  });

  it('goes as the owner in a turn another person asked for, and in one with no message', async () => {
    const { app, db, ceo, orchestrator, lena, running } = await quiet();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@example.com', access: { whole: true } });
    await takePlan(db, 'maria@example.com', orchestrator.id);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${orchestrator.id}/messages`, payload: { text: 'Invite my friend.' }, ...as(maria) })).statusCode).toBe(202);
    await newest(db, orchestrator.id, 'tool-token-maria-0123456789abcdef012');
    const asked = await call(await mcp(app, 'tool-token-maria-0123456789abcdef012'), 'invite_person', { name: 'Eve', email: 'eve@example.com', title: '', access: { whole: true } });
    expect(asked.isError, text(asked)).toBeFalsy();
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.agentId, orchestrator.id));
    await running(orchestrator.id, 'tool-token-timer-0123456789abcdef012');
    const client = await mcp(app, 'tool-token-timer-0123456789abcdef012');
    expect((await call(client, 'change_person', { person: lena.id, status: 'disabled' })).isError).toBeFalsy();
    expect(await statusOf(db, lena.id)).toBe('disabled');
  });

  /* Bruno asks the CEO about a machine in his task's card; the CEO answers there, not in the orchestrator's window. */
  async function askedInCard(c: Awaited<ReturnType<typeof quiet>>, topic: 'machines' | 'task', answer = true) {
    const asked = await ask(c.app.ctx, c.bruno.id, c.task.id, { kind: 'question', text: 'May dev-mac leave the test runs while #1 runs its tests?', topic });
    if (answer) expect((await c.app.inject({ method: 'POST', url: `/api/requests/${asked.request.id}`, payload: { answer: 'Yes, take it out for this run.' }, ...as(c.ceo) })).statusCode).toBe(200);
    return asked.request.id;
  }

  it("changes a machine in a turn nobody's words opened, as the owner, with no answer in a card", async () => {
    const c = await quiet();
    const [machine] = await c.db.insert(machines).values({ companyId: c.dev.companyId, personId: c.ceoId, machineKey: 'mac-0001-abcd', hostname: 'dev-mac' }).returning();
    await c.running(c.orchestrator.id, 'tool-token-timer-0123456789abcdef012');
    const client = await mcp(c.app, 'tool-token-timer-0123456789abcdef012');
    const lent = await call(client, 'lend_machine', { machine: machine!.id, lendsTests: false });
    expect(lent.isError, text(lent)).toBeFalsy();
    expect((await c.db.select().from(machines))[0]!.lendsTests).toBe(false);
  });

  it('takes no answer as a permission to change machines in a company with no owner but the CEO delegate\'s own one, in the card of a task still open', async () => {
    const c = await quiet();
    const [machine] = await c.db.insert(machines).values({ companyId: c.dev.companyId, personId: c.ceoId, machineKey: 'mac-0001-abcd', hostname: 'dev-mac' }).returning();
    await c.running(c.orchestrator.id, 'tool-token-timer-0123456789abcdef012');
    const client = await mcp(c.app, 'tool-token-timer-0123456789abcdef012');
    const lend = (permission: string) => call(client, 'lend_machine', { machine: machine!.id, lendsTests: false, permission });
    const NO_PERMISSION = "That answer is no permission to change machines: it is the CEO's or the CEO delegate's own answer to a question about machines, in the card of a task that is still open. Nothing was changed. Ask the CEO first.";
    const about = await askedInCard(c, 'task');
    const answered = await askedInCard(c, 'machines');
    await c.db.update(people).set({ isOwner: false }).where(eq(people.id, c.ceoId));
    expect(text(await lend(about)), 'an answer about the task').toBe(NO_PERMISSION);
    expect(text(await lend('00000000-0000-4000-8000-0000000000cc')), 'no such answer').toBe(NO_PERMISSION);
    expect(text(await lend(answered)), 'a person who is no longer the CEO').toBe(NO_PERMISSION);
    expect((await c.db.select().from(machines))[0]!.lendsTests).toBe(true);
  });

  it("counts a turn an employee woke as the CEO's once the CEO's message goes into it", async () => {
    const { app, db, ceo, orchestrator, hana, lena, running } = await quiet();
    await running(hana.id, HEAD_TOKEN);
    await call(await mcp(app, HEAD_TOKEN), 'tell_orchestrator', { text: 'Lena left.' });
    const woke = await newest(db, orchestrator.id, 'tool-token-woke-0123456789abcdef0123');
    vi.spyOn(app.ctx.hub, 'hasTerminals').mockReturnValue(true);
    vi.spyOn(app.ctx.hub, 'send').mockImplementation((node, m) => {
      /* The node types the words and says so once the message has gone. */
      if (m.type === 'agent.say') queueMicrotask(() => said(app.ctx, node, m.ref, true));
      return true;
    });
    const told = await app.inject({ method: 'POST', url: `/api/agents/${orchestrator.id}/messages`, payload: { text: 'Yes, disable her.' }, ...as(ceo) });
    expect(told.json().jobId).toBe(woke.id);
    expect((await call(await mcp(app, 'tool-token-woke-0123456789abcdef0123'), 'change_person', { person: lena.id, status: 'disabled' })).isError).toBeFalsy();
  });

  it('switches on a skill that shows the whole company, or moves itself to another subscription, in any turn, as the owner', async () => {
    const { app, db, orchestrator, bruno, running } = await quiet();
    await running(orchestrator.id, 'tool-token-timer-0123456789abcdef012');
    const client = await mcp(app, 'tool-token-timer-0123456789abcdef012');
    const [sub] = await db.select().from(subscriptions);
    const skilled = await call(client, 'change_employee', { employee: bruno.id, skills: { 'ops-task-watch': true } });
    expect(skilled.isError, text(skilled)).toBeFalsy();
    expect((await db.select().from(agents).where(eq(agents.id, bruno.id)))[0]!.skills).toContain('ops-task-watch');
    expect((await call(client, 'change_employee', { employee: orchestrator.id, subscription: sub!.id })).isError).toBeFalsy();
  });
});

const OPS_TOKEN = 'tool-token-ops-0123456789abcdef01234';

/* Wanda, the head of a new Operations department, on Bruno's subscription. */
async function opsHead(db: Awaited<ReturnType<typeof company>>['db'], bruno: Awaited<ReturnType<typeof company>>['bruno']) {
  const [ops] = await db.insert(departments).values({ companyId: bruno.companyId, templateKey: 'operations', roleCode: 'OPS' }).returning();
  return (await db.insert(agents).values({ companyId: bruno.companyId, kind: 'head', name: 'Wanda', roleKey: 'OPS-HEAD', departmentId: ops!.id, model: '', subscriptionId: bruno.subscriptionId }).returning())[0]!;
}
