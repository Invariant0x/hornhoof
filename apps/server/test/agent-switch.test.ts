import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentChanges, agents, companies, departments, jobs, people, requests, subscriptions, tasks } from '../src/db/schema.js';
import { pumpWaiting } from '../src/modules/conversation/queue.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { answer, ask, createTask, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { wakeAll, wakePrompt } from '../src/modules/tasks/wake.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { BASE, HEAD } from './development-echelons-fixture.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode, echelonsTurn } from './helpers.js';
import { BUILTIN } from './builtin.js';

const NODE_KEY = 'k'.repeat(40);

/* A company on the built-in node with Development: Hana at its head, Bruno and Bea on the backend, Rita and Rex reviewing,
   Rex on a Codex plan of the CEO's. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [] });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null, null, BUILTIN)!));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://github.com/acme/shop.git' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: 'claude-opus-5-5', subscriptionId: sub!.id, skills: app.ctx.templates.roles.get(roleKey)?.skills.filter(s => s.on).map(s => s.id) ?? [] }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const bea = await hire('Bea', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const [ceoPerson] = await db.select().from(people);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: ceoPerson!.id, status: 'ready' }).returning();
  const rex = (await db.insert(agents).values({ companyId, kind: 'worker', name: 'Rex', roleKey: 'DEV-REV', departmentId: dev!.id, model: 'gpt-6.1-sol', subscriptionId: codex!.id, skills: app.ctx.templates.roles.get('DEV-REV')!.skills.filter(s => s.on).map(s => s.id) }).returning())[0]!;
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const ctx = app.ctx;
  const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload, ...as(ceo) });
  ctx.readCommit = async (_repo, want) => ({ branch: 'task' in want ? `task-${want.task}` : want.branch, commitSha: HEAD });
  ctx.readCompare = async (_repo, want) => ({ complete: true, baseSha: want.base, headSha: want.head, paths: ['logic/totals.ts'], diff: '@@ -1 +1 @@\n-old\n+new' });
  const memberTask = async (executor = bruno.id, reviewerAgentId: string | undefined = rita.id) =>
    (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: executor, executor: true, small: true, paths: ['logic/totals.ts'], reviewerAgentId })).task;
  const snapshot = async (id: string) => {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id));
    return routeSnapshot(await routeOf(db, task!), task!.assigneeAgentId);
  };
  const jobsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them; the turn is not on the node. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const off = (...ids: string[]) => Promise.all(ids.map(id => db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, id))));
  /* On, but without a subscription to check anything with. */
  const unable = (...ids: string[]) => Promise.all(ids.map(id => db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, id))));
  await echelonsTurn(db, companyId);
  return { app, db, ctx, ceo, builtin, companyId, sub: sub!, codex: codex!, dev: dev!, orchestrator: orchestrator!, hana, bruno, bea, rita, rex, hire, patch, memberTask, snapshot, jobsOf, tools, off, unable };
}

async function mcp(app: FastifyInstance, token: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  onTestFinished(() => client.close());
  return client;
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args })) as Res;
const text = (r: Res) => r.content[0]!.text;
const work = (department: string, title: string) => ({ department, title, brief: `${title} brief`, body: `${title} body` });

async function nextRun(node: FakeNode): Promise<{ jobId: string; prompt: string }> {
  const m = await node.next();
  if (m.type !== 'job.run') throw new Error(`Expected job.run, got ${m.type}`);
  return m as { type: 'job.run'; jobId: string; prompt: string };
}

describe('switching an agent off and on', () => {
  it('switches an employee off and on from its card, shows it on the schema and logs who did it', async () => {
    const { app, db, ceo, bruno, patch } = await company();
    const off = await patch(bruno.id, { on: false });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ on: false });
    const org = (await app.inject({ method: 'GET', url: '/api/org', ...as(ceo) })).json() as { departments: { employees: { id: string; on: boolean }[] }[] };
    expect(org.departments[0]!.employees.find(e => e.id === bruno.id)).toMatchObject({ on: false });
    expect(org.departments[0]!.employees.filter(e => e.id !== bruno.id).every(e => e.on)).toBe(true);
    expect((await patch(bruno.id, { on: true })).json()).toMatchObject({ on: true });
    const log = await db.select({ field: agentChanges.field, before: agentChanges.before, after: agentChanges.after }).from(agentChanges).where(eq(agentChanges.agentId, bruno.id)).orderBy(asc(agentChanges.createdAt));
    expect(log).toEqual([
      { field: 'switch', before: true, after: false },
      { field: 'switch', before: false, after: true },
    ]);
  });

  it('gives the orchestrator no switch', async () => {
    const { orchestrator, patch } = await company();
    const res = await patch(orchestrator.id, { on: false });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('orchestrator_card');
  });

  it('waits for the head to assign Development again after an employee returns', async () => {
    const { ctx, db, builtin, hana, bruno, patch, memberTask, jobsOf } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await pumpWaiting(ctx);
    expect(await jobsOf(bruno.id)).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ assigneeAgentId: null, status: 'waiting' });
    const head = await nextRun(builtin);
    expect((await jobsOf(hana.id)).map(j => ({ id: j.id, status: j.status }))).toEqual([{ id: head.jobId, status: 'running' }]);
    expect(head.prompt).toContain(`#${task.number}`);
    expect(head.prompt).toContain('Bruno is no longer available');
    await patch(bruno.id, { on: true });
    expect(await jobsOf(bruno.id)).toEqual([]);
    expect((await jobsOf(hana.id)).map(j => j.id)).toEqual([head.jobId]);
    const revised = await updateTask(ctx, hana.id, task.id, { executor: bruno.id });
    await wakeAll(ctx, revised.wakes);
    const mine = (await jobsOf(bruno.id))[0]!.id;
    const run = await nextRun(builtin);
    expect(run.jobId).toBe(mine);
    expect((await db.select().from(jobs).where(eq(jobs.id, run.jobId)))[0]!.status).toBe('running');
  });

  it('still answers a person who writes to a switched-off employee', async () => {
    const { app, ceo, builtin, bruno, patch, jobsOf } = await company();
    await patch(bruno.id, { on: false });
    expect((await app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/messages`, payload: { text: 'What do you do?' }, ...as(ceo) })).statusCode).toBe(202);
    const run = await nextRun(builtin);
    expect(run.prompt).toContain('What do you do?');
    expect((await jobsOf(bruno.id)).map(j => j.status)).toEqual(['running']);
  });
});

describe('giving work to agents that are on', () => {
  it('tells the head who is on and refuses a task for an employee that is off', async () => {
    const { hana, bruno, bea, off, tools } = await company();
    await off(bruno.id);
    const head = await tools(hana);
    const team = JSON.parse(text(await call(head, 'company', {}))) as { departments: { employees: { id: string; on: boolean }[] }[] };
    const staff = team.departments[0]!.employees;
    expect(staff.find(e => e.id === bruno.id)!.on).toBe(false);
    expect(staff.find(e => e.id === bea.id)!.on).toBe(true);
    const refused = await call(head, 'create_task', { paths: ['checkout/**'], title: 'Checkout API', brief: 'b', body: 'b', executor: bruno.id });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Bruno is switched off');
    expect((await call(head, 'create_task', { paths: ['checkout/**'], title: 'Checkout API', brief: 'b', body: 'b', executor: bea.id })).isError).toBeFalsy();
  });

  it('refuses to hand a task over to an employee that is off', async () => {
    const { db, hana, bruno, bea, off, tools, memberTask } = await company();
    const task = await memberTask();
    await off(bea.id);
    const res = await call(await tools(hana), 'update_task', { task: task.number, executor: bea.id });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('new owner must be available');
    expect((await row(db, task.id)).assigneeAgentId).toBe(bruno.id);
  });

  it('gives no work to a department whose head is off, or whose employees are all off', async () => {
    const { dev, hana, bruno, bea, rita, rex, orchestrator, off, tools, db } = await company();
    const boss = await tools(orchestrator);
    await off(hana.id);
    const headless = await call(boss, 'add_tasks', { tasks: [work(dev.id, 'Checkout')] });
    expect(headless.isError).toBe(true);
    expect(text(headless)).toContain('switched off');
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, hana.id));
    await off(bruno.id, bea.id, rita.id, rex.id);
    const empty = await call(boss, 'add_tasks', { tasks: [work(dev.id, 'Checkout')] });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain('switched off');
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, rex.id));
    expect((await call(boss, 'add_tasks', { tasks: [work(dev.id, 'Checkout')] })).isError).toBeFalsy();
  });
});

const done = { summary: 'Done.', evidence: 'Changed total tests.', review: { baseCommit: BASE } };
const row = async (db: Awaited<ReturnType<typeof company>>['db'], id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const told = async (db: Awaited<ReturnType<typeof company>>['db'], agentId: string, words: string) =>
  (await db.select().from(jobs).where(eq(jobs.agentId, agentId))).some(j => j.prompt.includes(words));

describe('one eligible owner of the required Review', () => {
  it('sends the candidate to one named reviewer and never fans out to another provider', async () => {
    const { ctx, bruno, rita, rex, memberTask, snapshot } = await company();
    const task = await memberTask();
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'review', assigneeAgentId: rita.id });
    expect(sent.wakes.map(w => w.agentId)).toEqual([rita.id]);
    expect(await snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: rita.id });
    await expect(verdict(ctx, rex.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' })).rejects.toMatchObject({ reason: 'task_not_yours' });
    const passed = await verdict(ctx, rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' });
    expect(passed.task.status).not.toBe('done');
    expect((await snapshot(task.id)).stage).toBe('tests');
  });

  it('keeps Review waiting when every eligible checker is off instead of skipping it', async () => {
    const { ctx, bruno, rita, rex, hana, off, memberTask, snapshot } = await company();
    const task = await memberTask();
    await off(rita.id, rex.id);
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'waiting', assigneeAgentId: null });
    expect(sent.wakes.map(w => w.agentId)).toEqual([hana.id]);
    expect(await snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'waiting', ownerAgentId: null });
  });

  it('lets the head assign an available checker while retaining the candidate and rewritten brief', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, unable, tools, memberTask, snapshot } = await company();
    const task = await memberTask();
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, task.id, done);
    const candidateId = (await snapshot(task.id)).candidateId;
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, rex.id));
    const res = await call(await tools(hana), 'update_task', { task: task.number, ownerAgentId: rex.id, title: 'Checkout API with tax', body: 'POST /checkout, tax included.' });
    expect(res.isError).toBeFalsy();
    expect(await row(db, task.id)).toMatchObject({ title: 'Checkout API with tax', body: 'POST /checkout, tax included.', assigneeAgentId: rex.id });
    expect(await snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: rex.id, candidateId });
  });

  it('keeps a finding with its checker even when the original producer is off', async () => {
    const { ctx, bruno, rita, off, memberTask, snapshot } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    const candidateId = (await snapshot(task.id)).candidateId;
    await off(bruno.id);
    const repair = await verdict(ctx, rita.id, task.id, { pass: false, reviewedCommit: HEAD, comment: 'The total ignores tax.' });
    expect(repair.task.assigneeAgentId).toBe(rita.id);
    expect(repair.wakes.some(w => w.agentId === bruno.id)).toBe(false);
    expect(await snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: rita.id, candidateId });
  });

  it('allows only the current owner to ask and waits for the answer before accepting its verdict', async () => {
    const { ctx, db, bruno, rita, rex, memberTask, snapshot } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await expect(ask(ctx, rex.id, task.id, { kind: 'question', text: 'Which currency?' })).rejects.toMatchObject({ reason: 'task_not_yours' });
    const asked = await ask(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    await expect(verdict(ctx, rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    const [ceo] = await db.select().from(people);
    const answered = await answer(ctx, { personId: ceo!.id }, asked.request.id, { answer: 'Yes, with tax.' });
    expect(answered.wakes.map(w => [w.agentId, w.why])).toEqual([[rita.id, 'answered']]);
    await verdict(ctx, rita.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Tax is covered.' });
    expect((await snapshot(task.id)).stage).toBe('tests');
  });
});

describe('work an agent held when it was switched off', () => {
  it('waits for the head to assign someone who is on', async () => {
    const { db, hana, bruno, bea, patch, tools, memberTask, snapshot } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: null, executorAgentId: bruno.id, status: 'waiting' });
    expect(await snapshot(task.id)).toMatchObject({ stage: 'development', phase: 'waiting', ownerAgentId: null });
    expect(await told(db, hana.id, 'Bruno is no longer available')).toBe(true);
    expect((await call(await tools(hana), 'update_task', { task: task.number, executor: bea.id })).isError).toBeFalsy();
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: bea.id, executorAgentId: bea.id });
    expect(await snapshot(task.id)).toMatchObject({ stage: 'development', phase: 'active', ownerAgentId: bea.id });
  });

  it('reminds a waiting reviewer to finish its current checking stage', async () => {
    const { ctx, db, rita, rex, memberTask } = await company();
    const task = await memberTask(rex.id);
    await submit(ctx, rex.id, task.id, done);
    await ask(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    const waiting = await row(db, task.id);
    expect(waiting.status).toBe('waiting');
    expect(wakePrompt(rita, waiting, { agentId: rita.id, taskId: task.id, why: 'reminder' })).toContain('use blocked or escalate a wrong goal to the head');
  });

  it('drops queued turns after the switched-off employee leaves its assignment', async () => {
    const { ctx, db, bruno, patch, memberTask, off } = await company();
    const task = await memberTask();
    await off(bruno.id);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'queued')))).toHaveLength(1);
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, bruno.id));
    await patch(bruno.id, { on: false });
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'queued')))).toEqual([]);
  });

  it('returns to the same employee only after the head explicitly assigns it again', async () => {
    const { db, hana, bruno, patch, tools, memberTask } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    await patch(bruno.id, { on: true });
    expect((await row(db, task.id)).assigneeAgentId).toBeNull();
    expect((await call(await tools(hana), 'update_task', { task: task.number, executor: bruno.id })).isError).toBeFalsy();
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: bruno.id, executorAgentId: bruno.id });
  });

  it('stays with the employee until its running turn ends', async () => {
    const { ctx, db, companyId, sub, bruno, patch, memberTask, snapshot } = await company();
    const task = await memberTask();
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'work', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    await patch(bruno.id, { on: false });
    expect((await row(db, task.id)).assigneeAgentId).toBe(bruno.id);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(ctx, job!.id);
    expect((await row(db, task.id)).assigneeAgentId).toBeNull();
    expect(await snapshot(task.id)).toMatchObject({ stage: 'development', phase: 'waiting', ownerAgentId: null });
  });

  it('gives Review to another eligible checker without losing its unanswered question or candidate', async () => {
    const { ctx, db, bruno, rita, rex, patch, memberTask, snapshot } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    const candidateId = (await snapshot(task.id)).candidateId;
    const asked = await ask(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    expect((await patch(rita.id, { on: false })).statusCode).toBe(200);
    expect(await snapshot(task.id)).toMatchObject({ stage: 'review', ownerAgentId: rex.id, candidateId });
    await expect(verdict(ctx, rex.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    const [ceo] = await db.select().from(people);
    const answered = await answer(ctx, { personId: ceo!.id }, asked.request.id, { answer: 'Yes, with tax.' });
    expect(answered.wakes.map(w => w.agentId)).toEqual([rex.id]);
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, rita.id), eq(jobs.status, 'queued')))).toEqual([]);
    await verdict(ctx, rex.id, task.id, { pass: true, reviewedCommit: HEAD, comment: 'Tax is covered.' });
    expect((await snapshot(task.id)).stage).toBe('tests');
  });

  /* Move the other task between the switch reading its rows and updating them. */
  const meddle = (
    ctx: Awaited<ReturnType<typeof company>>['ctx'],
    db: Awaited<ReturnType<typeof company>>['db'],
    ids: string[],
    how: (other: string) => Promise<unknown> = other => db.update(tasks).set({ version: sql`${tasks.version} + 1` }).where(eq(tasks.id, other)),
  ) => {
    const publish = ctx.bus.publish.bind(ctx.bus);
    let done = false;
    ctx.bus.publish = ((companyId: string, e: { type: string; id?: string }) => {
      if (!done && e.type === 'task' && e.id && ids.includes(e.id)) {
        done = true;
        void how(ids.find(id => id !== e.id)!).then(() => undefined);
      }
      return publish(companyId, e as never);
    }) as typeof ctx.bus.publish;
    onTestFinished(() => { ctx.bus.publish = publish; });
  };

  it('resumes every waiting Review once an eligible checker returns despite a concurrent task edit', async () => {
    const { ctx, db, bruno, bea, rita, rex, off, unable, patch, memberTask, snapshot } = await company();
    const one = await memberTask(bruno.id);
    const two = await memberTask(bea.id);
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, one.id, done);
    await submit(ctx, bea.id, two.id, done);
    const candidates = await Promise.all([one, two].map(t => snapshot(t.id)));
    meddle(ctx, db, [one.id, two.id]);
    await patch(rex.id, { on: true });
    for (const [i, task] of [one, two].entries()) {
      expect(await snapshot(task.id)).toMatchObject({ stage: 'review', phase: 'active', ownerAgentId: rex.id, candidateId: candidates[i]!.candidateId });
      expect((await db.select().from(jobs).where(and(eq(jobs.agentId, rex.id), eq(jobs.taskId, task.id)))).length).toBe(1);
    }
  });

  it('leaves every assignment when an employee is switched off despite a concurrent task edit', async () => {
    const { ctx, db, bruno, patch, memberTask, snapshot } = await company();
    const one = await memberTask();
    const two = await memberTask();
    meddle(ctx, db, [one.id, two.id]);
    await patch(bruno.id, { on: false });
    for (const task of [one, two]) {
      expect((await row(db, task.id)).assigneeAgentId).toBeNull();
      expect(await snapshot(task.id)).toMatchObject({ stage: 'development', phase: 'waiting', ownerAgentId: null });
    }
  });

  it('preserves a question arriving concurrently with its reviewer being switched off', async () => {
    const { ctx, db, companyId, bruno, bea, rita, patch, memberTask, snapshot } = await company();
    const one = await memberTask(bruno.id);
    const two = await memberTask(bea.id);
    await submit(ctx, bruno.id, one.id, done);
    await submit(ctx, bea.id, two.id, done);
    let requestId: string | undefined;
    meddle(ctx, db, [one.id, two.id], async other => {
      const [request] = await db.insert(requests).values({ companyId, taskId: other, agentId: rita.id, kind: 'question', text: 'Is tax in scope?' }).returning();
      requestId = request!.id;
      await db.update(tasks).set({ status: 'waiting', version: sql`${tasks.version} + 1` }).where(eq(tasks.id, other));
    });
    await patch(rita.id, { on: false });
    expect(requestId).toBeDefined();
    const [question] = await db.select().from(requests).where(eq(requests.id, requestId!));
    expect(question).toMatchObject({ agentId: rita.id, status: 'open' });
    const current = await snapshot(question!.taskId);
    expect(current.stage).toBe('review');
    expect(current.ownerAgentId).not.toBe(rita.id);
    await expect(verdict(ctx, current.ownerAgentId!, question!.taskId, { pass: true, reviewedCommit: HEAD, comment: 'Fine.' })).rejects.toMatchObject({ reason: 'task_invalid' });
  });
});
