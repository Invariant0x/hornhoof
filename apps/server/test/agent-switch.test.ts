import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentChanges, agents, companies, departments, jobs, subscriptions, tasks } from '../src/db/schema.js';
import { afterJob, pumpWaiting } from '../src/modules/conversation/queue.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { createTask, submit, verdict } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);

/* A company on the built-in node with Development: Hana at its head, Bruno and Bea on the backend, Rita and Rex reviewing. */
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
  await until(() => app.ctx.hub.isReady(identityOf(sub!)));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const bea = await hire('Bea', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const rex = await hire('Rex', 'worker', 'DEV-REV');
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const ctx = app.ctx;
  const patch = (id: string, payload: object) => app.inject({ method: 'PATCH', url: `/api/agents/${id}`, payload, ...as(ceo) });
  const memberTask = async (executor = bruno.id, gates = [rita.id]) =>
    (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: executor, executor: true, gates })).task;
  const jobsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  let n = 0;
  /* Hornhoof's tools as a running turn of this agent sees them; the turn is not on the node. */
  const tools = async (agent: { id: string }) => {
    const token = `tool-token-${++n}-0123456789abcdef0123456789`;
    await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: agent.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token) });
    return mcp(app, token);
  };
  const off = (...ids: string[]) => Promise.all(ids.map(id => db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, id))));
  return { app, db, ctx, ceo, builtin, companyId, sub: sub!, dev: dev!, orchestrator: orchestrator!, hana, bruno, bea, rita, rex, patch, memberTask, jobsOf, tools, off };
}

async function mcp(app: FastifyInstance, token: string): Promise<Client> {
  const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  onTestFinished(() => client.close());
  return client;
}

type Res = { content: { text: string }[]; isError?: boolean };
const call = async (c: Client, name: string, args: object) => (await c.callTool({ name, arguments: args })) as Res;
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

  it("keeps a switched-off employee's task turns waiting and sends them when it is on again", async () => {
    const { ctx, db, builtin, bruno, patch, memberTask, jobsOf } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await pumpWaiting(ctx);
    expect((await jobsOf(bruno.id)).map(j => j.status)).toEqual(['queued']);
    await patch(bruno.id, { on: true });
    /* The head hears first that the work came back to it; Bruno's turn goes out once it is on. */
    const mine = (await jobsOf(bruno.id))[0]!.id;
    let run = await nextRun(builtin);
    while (run.jobId !== mine) run = await nextRun(builtin);
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
    const refused = await call(head, 'create_task', { title: 'Checkout API', brief: 'b', body: 'b', executor: bruno.id, gates: [] });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Bruno is switched off');
    expect((await call(head, 'create_task', { title: 'Checkout API', brief: 'b', body: 'b', executor: bea.id, gates: [] })).isError).toBeFalsy();
  });

  it('refuses to hand a task over to an employee that is off', async () => {
    const { hana, bea, off, tools, memberTask } = await company();
    const task = await memberTask();
    await off(bea.id);
    const res = await call(await tools(hana), 'update_task', { task: task.number, executor: bea.id });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Bea is switched off');
  });

  it('gives no turn work to a department whose head is off, or whose employees are all off', async () => {
    const { dev, hana, bruno, bea, rita, rex, orchestrator, off, tools, db } = await company();
    const boss = await tools(orchestrator);
    await off(hana.id);
    const headless = await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    expect(headless.isError).toBe(true);
    expect(text(headless)).toContain('switched off');
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, hana.id));
    await off(bruno.id, bea.id, rita.id, rex.id);
    const empty = await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    expect(empty.isError).toBe(true);
    expect(text(empty)).toContain('switched off');
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, rex.id));
    expect((await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] })).isError).toBeFalsy();
  });

  it("holds a planned task whose department's head was switched off before its turn, and tells the orchestrator", async () => {
    const { db, dev, hana, orchestrator, off, tools, jobsOf } = await company();
    const boss = await tools(orchestrator);
    await call(boss, 'plan_turn', { title: 'Payments', goal: 'Card payments.', tasks: [work(dev.id, 'Checkout')] });
    await call(boss, 'plan_turn', { title: 'Refunds', goal: 'Money goes back.', tasks: [work(dev.id, 'Refund button')] });
    await off(hana.id);
    await call(boss, 'cancel_task', { task: 1, why: 'Not needed.' });
    expect((await db.select().from(tasks).where(eq(tasks.title, 'Refund button')))[0]).toMatchObject({ status: 'blocked', assigneeAgentId: null });
    const waiting = (await jobsOf(orchestrator.id)).filter(j => j.status === 'queued');
    expect(waiting.some(j => j.prompt.includes('switched off'))).toBe(true);
  });
});

describe('reviewers of one role checking the same work', () => {
  const done = { summary: 'Done.', evidence: 'npm test: 12 passed' };

  it('sends the work to every reviewer of the gate role that is on and passes the gate once all of them pass', async () => {
    const { ctx, db, bruno, rita, rex, hana, memberTask } = await company();
    const task = await memberTask();
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'review', stage: 1, panel: [rita.id, rex.id] });
    expect(sent.wakes.map(w => [w.agentId, w.why])).toEqual([
      [rita.id, 'review'],
      [rex.id, 'review'],
    ]);
    const first = await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Looks right.' });
    expect(first.task).toMatchObject({ status: 'review', stage: 1, panel: [rex.id], assigneeAgentId: rex.id });
    expect(first.wakes).toEqual([]);
    const last = await verdict(ctx, rex.id, task.id, { pass: true, comment: 'Tests cover it.' });
    expect(last.task.status).toBe('done');
    expect(last.wakes.map(w => [w.agentId, w.why])).toEqual([[hana.id, 'done']]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.panel).toEqual([]);
  });

  it('leaves reviewers that are off out of the gate', async () => {
    const { ctx, bruno, rita, rex, off, memberTask } = await company();
    const task = await memberTask(bruno.id, [rex.id]);
    await off(rex.id);
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ panel: [rita.id], assigneeAgentId: rita.id });
  });

  it('sends the work back with every reason in one list once all reviewers have checked it', async () => {
    const { ctx, bruno, rita, rex, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: false, comment: 'No test for an empty cart.' });
    const back = await verdict(ctx, rex.id, task.id, { pass: false, comment: 'The total ignores tax.' });
    expect(back.task).toMatchObject({ status: 'open', stage: 0, panel: [], assigneeAgentId: bruno.id, bounces: 1 });
    const [w] = back.wakes;
    expect(w).toMatchObject({ agentId: bruno.id, why: 'changes' });
    expect(w!.text).toContain('Rita: No test for an empty cart.');
    expect(w!.text).toContain('Rex: The total ignores tax.');
  });

  it('sends the work back when one reviewer asks for changes and the other passes it', async () => {
    const { ctx, bruno, rita, rex, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine by me.' });
    const back = await verdict(ctx, rex.id, task.id, { pass: false, comment: 'The total ignores tax.' });
    expect(back.task).toMatchObject({ status: 'open', stage: 0 });
    expect(back.wakes[0]!.text).toContain('Rex: The total ignores tax.');
    expect(back.wakes[0]!.text).not.toContain('Fine by me.');
  });

  it('takes one verdict from each reviewer in a round', async () => {
    const { ctx, bruno, rita, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' });
    await expect(verdict(ctx, rita.id, task.id, { pass: false, comment: 'Wait.' })).rejects.toMatchObject({ reason: 'task_not_yours' });
  });

  it('gives the work to the head when nobody of the gate role is on', async () => {
    const { ctx, bruno, rita, rex, hana, off, memberTask } = await company();
    const task = await memberTask();
    await off(rita.id, rex.id);
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'review', stage: 1, panel: [], assigneeAgentId: hana.id });
    expect(sent.wakes).toHaveLength(1);
    expect(sent.wakes[0]).toMatchObject({ agentId: hana.id, why: 'switched' });
    expect(sent.wakes[0]!.text).toContain('Nobody');
  });

  it('lets the head give such a task other gates, which start at once', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, tools, memberTask, companyId, dev, sub } = await company();
    const [sec] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Sam', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sub.id }).returning();
    const task = await memberTask();
    await off(rita.id, rex.id);
    await submit(ctx, bruno.id, task.id, done);
    const res = await call(await tools(hana), 'update_task', { task: task.number, gates: ['DEV-SEC'] });
    expect(res.isError).toBeFalsy();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ status: 'review', stage: 1, gates: [sec!.id], panel: [sec!.id], assigneeAgentId: sec!.id });
    expect((await db.select().from(jobs).where(and(eq(jobs.agentId, sec!.id), eq(jobs.status, 'queued')))).length + (await db.select().from(jobs).where(and(eq(jobs.agentId, sec!.id), eq(jobs.status, 'running')))).length).toBe(1);
  });
});

describe('work an agent held when it was switched off', () => {
  const done = { summary: 'Done.', evidence: 'npm test: 12 passed' };
  const row = async (db: Awaited<ReturnType<typeof company>>['db'], id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
  const told = async (db: Awaited<ReturnType<typeof company>>['db'], agentId: string, words: string) =>
    (await db.select().from(jobs).where(eq(jobs.agentId, agentId))).some(j => j.prompt.includes(words));

  it('goes back to the head, who can give it to someone who is on', async () => {
    const { db, hana, bruno, bea, patch, tools, memberTask } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    /* The head's turn on it starts at once. */
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: hana.id, executorAgentId: bruno.id, stage: 0 });
    expect(await told(db, hana.id, 'Bruno does it and was switched off')).toBe(true);
    expect((await call(await tools(hana), 'update_task', { task: task.number, executor: bea.id })).isError).toBeFalsy();
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: bea.id, executorAgentId: bea.id });
  });

  it('drops the turns that waited for the employee on work it handed back', async () => {
    const { ctx, db, bruno, patch, memberTask, off } = await company();
    const task = await memberTask();
    await off(bruno.id);
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await db.update(agents).set({ switchedOffAt: null }).where(eq(agents.id, bruno.id));
    await patch(bruno.id, { on: false });
    expect((await db.select().from(jobs).where(and(eq(jobs.agentId, bruno.id), eq(jobs.status, 'queued'))))).toEqual([]);
  });

  it('goes back to the same employee when the head gives it back once it is on again', async () => {
    const { db, hana, bruno, patch, tools, memberTask } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    await patch(bruno.id, { on: true });
    expect((await call(await tools(hana), 'update_task', { task: task.number, executor: bruno.id })).isError).toBeFalsy();
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: bruno.id, executorAgentId: bruno.id });
  });

  it('stays with the employee until the turn it runs is over', async () => {
    const { ctx, db, companyId, sub, hana, bruno, patch, memberTask } = await company();
    const task = await memberTask();
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub.id, agentId: bruno.id, taskId: task.id, kind: 'conversation', prompt: 'work', timeoutMs: 900000, status: 'running', startedAt: new Date() }).returning();
    await patch(bruno.id, { on: false });
    expect((await row(db, task.id)).assigneeAgentId).toBe(bruno.id);
    await db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, job!.id));
    await afterJob(ctx, job!.id);
    expect((await row(db, task.id)).assigneeAgentId).toBe(hana.id);
  });

  it('leaves the gate a switched-off reviewer was checking to the others there', async () => {
    const { ctx, db, bruno, rita, rex, patch, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await patch(rex.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ panel: [rita.id], assigneeAgentId: rita.id, status: 'review' });
    expect((await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' })).task.status).toBe('done');
  });

  it('decides the gate with the verdicts given when the last reviewer still checking is switched off', async () => {
    const { ctx, db, bruno, rita, rex, patch, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: false, comment: 'No test for an empty cart.' });
    await patch(rex.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ stage: 0, assigneeAgentId: bruno.id, panel: [], bounces: 1 });
    expect(await told(db, bruno.id, 'No test for an empty cart.')).toBe(true);
  });

  it('waits with the head when the only reviewer at the gate is switched off', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, patch, memberTask } = await company();
    const task = await memberTask();
    await off(rex.id);
    await submit(ctx, bruno.id, task.id, done);
    await patch(rita.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ status: 'review', stage: 1, panel: [], assigneeAgentId: hana.id });
    expect(await told(db, hana.id, 'Nobody who can check it at gate 1')).toBe(true);
  });
});
