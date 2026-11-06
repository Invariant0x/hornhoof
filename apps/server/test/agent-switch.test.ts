import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentChanges, agents, companies, departments, jobs, people, requests, subscriptions, tasks, turns } from '../src/db/schema.js';
import { pumpWaiting } from '../src/modules/conversation/queue.js';
import { afterJob } from '../src/modules/tasks/wake.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { answer, createTask, submit, updateTask, verdict } from '../src/modules/tasks/engine.js';
import { wakeAll, wakePrompt } from '../src/modules/tasks/wake.js';
import { as, askedOfPerson, connectNode, listen, setUpCompany, testApp, type FakeNode, until } from './helpers.js';

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
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null)!));
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId: dev!.id, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-BE');
  const bea = await hire('Bea', 'worker', 'DEV-BE');
  const rita = await hire('Rita', 'worker', 'DEV-REV');
  const [ceoPerson] = await db.select().from(people);
  const [codex] = await db.insert(subscriptions).values({ companyId, provider: 'codex', kind: 'personal', label: 'Codex', ownerPersonId: ceoPerson!.id, status: 'ready' }).returning();
  const rex = (await db.insert(agents).values({ companyId, kind: 'worker', name: 'Rex', roleKey: 'DEV-REV', departmentId: dev!.id, model: '', subscriptionId: codex!.id }).returning())[0]!;
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
  /* On, but without a subscription to check anything with. */
  const unable = (...ids: string[]) => Promise.all(ids.map(id => db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, id))));
  return { app, db, ctx, ceo, builtin, companyId, sub: sub!, codex: codex!, dev: dev!, orchestrator: orchestrator!, hana, bruno, bea, rita, rex, hire, patch, memberTask, jobsOf, tools, off, unable };
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

  it('keeps work with the head until it is assigned again after an employee returns', async () => {
    const { ctx, db, builtin, hana, bruno, patch, memberTask, jobsOf } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    await pumpWaiting(ctx);
    expect(await jobsOf(bruno.id)).toEqual([]);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ assigneeAgentId: hana.id });
    const head = await nextRun(builtin);
    expect((await jobsOf(hana.id)).map(j => ({ id: j.id, status: j.status }))).toEqual([{ id: head.jobId, status: 'running' }]);
    expect(head.prompt).toContain(`#${task.number}`);
    expect(head.prompt).toContain('Bruno does it and was switched off');
    await patch(bruno.id, { on: true });
    expect(await jobsOf(bruno.id)).toEqual([]);
    expect((await jobsOf(hana.id)).map(j => j.id)).toEqual([head.jobId]);
    const assigned = await updateTask(ctx, hana.id, task.id, { executor: bruno.id });
    await wakeAll(ctx, assigned.wakes);
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

  it('asks one reviewer of each provider, the least busy of each and the oldest on a tie, whoever the gate names', async () => {
    const { ctx, bruno, bea, rita, rex, hire, memberTask } = await company();
    const rose = await hire('Rose', 'worker', 'DEV-REV');
    const first = await memberTask(bruno.id, [rose.id]);
    expect((await submit(ctx, bruno.id, first.id, done)).task.panel).toEqual([rita.id, rex.id]);
    const second = await memberTask(bea.id);
    const sent = await submit(ctx, bea.id, second.id, done);
    expect(sent.task.panel).toEqual([rex.id, rose.id]);
    expect(sent.wakes.map(w => [w.agentId, w.why])).toEqual([
      [rex.id, 'review'],
      [rose.id, 'review'],
    ]);
  });

  it('asks one reviewer when everyone of the role who is on runs on one provider', async () => {
    const { ctx, bruno, rita, rex, hire, off, memberTask } = await company();
    await hire('Rose', 'worker', 'DEV-REV');
    await off(rex.id);
    const task = await memberTask();
    expect((await submit(ctx, bruno.id, task.id, done)).task).toMatchObject({ panel: [rita.id], assigneeAgentId: rita.id });
  });

  it('asks only the reviewers who sent it back in the next round, each to check the fixes for its own findings', async () => {
    const { ctx, db, bruno, rita, rex, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine by me.' });
    await verdict(ctx, rex.id, task.id, { pass: false, comment: 'The total ignores tax.' });
    const again = await submit(ctx, bruno.id, task.id, { summary: 'Tax added.', evidence: 'npm test: 13 passed' });
    expect(again.task).toMatchObject({ status: 'review', stage: 1, panel: [rex.id], assigneeAgentId: rex.id });
    expect(again.wakes.map(w => [w.agentId, w.why])).toEqual([[rex.id, 'review']]);
    const [me] = await db.select().from(agents).where(eq(agents.id, rex.id));
    const prompt = wakePrompt(me!, again.task, again.wakes[0]!);
    expect(prompt).toContain('The total ignores tax.');
    expect(prompt).toContain('Check only the fixes for your own findings');
    expect((await verdict(ctx, rex.id, task.id, { pass: true, comment: 'Tax is in.' })).task.status).toBe('done');
  });

  it('goes back to the gate that sent it back, past the gates it passed, and to a fresh reviewer there when those are off', async () => {
    const { ctx, db, bruno, rita, rex, off, memberTask, companyId, dev, sub } = await company();
    const [sam] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Sam', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sub.id }).returning();
    const task = await memberTask(bruno.id, [rita.id, sam!.id]);
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' });
    await verdict(ctx, rex.id, task.id, { pass: true, comment: 'Fine.' });
    await verdict(ctx, sam!.id, task.id, { pass: false, comment: 'The token is logged.' });
    expect((await submit(ctx, bruno.id, task.id, done)).task).toMatchObject({ status: 'review', stage: 2, panel: [sam!.id] });
    await verdict(ctx, sam!.id, task.id, { pass: true, comment: 'Gone.' });
    const other = await memberTask(bruno.id, [rita.id]);
    await submit(ctx, bruno.id, other.id, done);
    await verdict(ctx, rita.id, other.id, { pass: true, comment: 'Fine.' });
    await verdict(ctx, rex.id, other.id, { pass: false, comment: 'No test.' });
    await off(rex.id);
    expect((await submit(ctx, bruno.id, other.id, done)).task).toMatchObject({ stage: 1, panel: [rita.id] });
  });

  it('checks the work once at a role that two gates name, since its whole panel checks it at the first', async () => {
    const { ctx, db, bruno, rita, rex, hana, memberTask, companyId, dev, sub } = await company();
    const [sam] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Sam', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sub.id }).returning();
    const task = await memberTask(bruno.id, [rita.id, rex.id, sam!.id]);
    expect((await submit(ctx, bruno.id, task.id, done)).task).toMatchObject({ stage: 1, panel: [rita.id, rex.id] });
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' });
    expect((await verdict(ctx, rex.id, task.id, { pass: true, comment: 'Fine.' })).task).toMatchObject({ status: 'review', stage: 3, panel: [sam!.id] });
    const last = await verdict(ctx, sam!.id, task.id, { pass: true, comment: 'No secrets.' });
    expect(last.task.status).toBe('done');
    expect(last.wakes.map(w => [w.agentId, w.why])).toEqual([[hana.id, 'done']]);
  });

  it('brings work sent back from a second gate of a role back to it, as for a task that reached it before', async () => {
    const { ctx, db, bruno, rita, rex, memberTask } = await company();
    const task = await memberTask(bruno.id, [rita.id, rex.id]);
    await submit(ctx, bruno.id, task.id, done);
    await db.update(tasks).set({ stage: 2, panel: [rex.id], assigneeAgentId: rex.id }).where(eq(tasks.id, task.id));
    await verdict(ctx, rex.id, task.id, { pass: false, comment: 'No test.' });
    expect((await submit(ctx, bruno.id, task.id, done)).task).toMatchObject({ status: 'review', stage: 2, panel: [rex.id] });
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

  it('takes a gate whose whole role is switched off out of the way, on to the next gate', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, memberTask, companyId, dev, sub } = await company();
    const [sam] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Sam', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sub.id }).returning();
    const task = await memberTask(bruno.id, [rita.id, sam!.id]);
    await off(rita.id, rex.id);
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'review', stage: 2, panel: [sam!.id], assigneeAgentId: sam!.id });
    expect(sent.wakes).toEqual([expect.objectContaining({ agentId: sam!.id, why: 'review' })]);
    expect(sent.wakes.some(w => w.agentId === hana.id)).toBe(false);
  });

  it('finishes a task whose gates left all have their whole role switched off', async () => {
    const { ctx, bruno, rita, rex, hana, off, memberTask } = await company();
    const task = await memberTask();
    await off(rita.id, rex.id);
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'done', panel: [] });
    expect(sent.wakes).toEqual([expect.objectContaining({ agentId: hana.id, why: 'done' })]);
  });

  it('gives the work to the head when people of the gate role are on but none of them can check it', async () => {
    const { ctx, bruno, rita, rex, hana, off, unable, memberTask } = await company();
    const task = await memberTask();
    await off(rex.id);
    await unable(rita.id);
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task).toMatchObject({ status: 'review', stage: 1, panel: [], assigneeAgentId: hana.id });
    expect(sent.wakes).toHaveLength(1);
    expect(sent.wakes[0]).toMatchObject({ agentId: hana.id, why: 'switched' });
    expect(sent.wakes[0]!.text).toContain('Rita has no subscription');
  });

  it('lets the head give such a task other gates, which start at once', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, unable, tools, memberTask, companyId, dev, sub } = await company();
    const [sec] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Sam', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sub.id }).returning();
    const task = await memberTask();
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, task.id, done);
    const res = await call(await tools(hana), 'update_task', { task: task.number, gates: ['DEV-SEC'] });
    expect(res.isError).toBeFalsy();
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row).toMatchObject({ status: 'review', stage: 1, gates: [sec!.id], panel: [sec!.id], assigneeAgentId: sec!.id });
    expect((await db.select().from(jobs).where(and(eq(jobs.agentId, sec!.id), eq(jobs.status, 'queued')))).length + (await db.select().from(jobs).where(and(eq(jobs.agentId, sec!.id), eq(jobs.status, 'running')))).length).toBe(1);
  });

  it('keeps the words the head rewrites while giving such a task other gates', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, unable, tools, memberTask, companyId, dev, sub } = await company();
    await db.insert(agents).values({ companyId, kind: 'worker', name: 'Sam', roleKey: 'DEV-SEC', departmentId: dev.id, model: '', subscriptionId: sub.id });
    const task = await memberTask();
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, task.id, done);
    const res = await call(await tools(hana), 'update_task', { task: task.number, gates: ['DEV-SEC'], title: 'Checkout API with tax', body: 'POST /checkout, tax included.' });
    expect(res.isError).toBeFalsy();
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ title: 'Checkout API with tax', body: 'POST /checkout, tax included.', stage: 1 });
  });

  it('gives work sent back from a gate to the head when its executor is off', async () => {
    const { ctx, bruno, rita, rex, hana, off, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    await off(bruno.id);
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' });
    const back = await verdict(ctx, rex.id, task.id, { pass: false, comment: 'The total ignores tax.' });
    expect(back.task).toMatchObject({ status: 'open', stage: 0, assigneeAgentId: hana.id, executorAgentId: bruno.id, bounces: 1 });
    expect(back.wakes.map(w => [w.agentId, w.why])).toEqual([[hana.id, 'switched']]);
    expect(back.wakes[0]!.text).toContain('Bruno');
    expect(back.wakes[0]!.text).toContain('The total ignores tax.');
  });

  it('lets any reviewer at the gate ask a person', async () => {
    const { ctx, bruno, rita, rex, memberTask } = await company();
    const task = await memberTask();
    const sent = await submit(ctx, bruno.id, task.id, done);
    expect(sent.task.assigneeAgentId).toBe(rita.id);
    const asked = await askedOfPerson(ctx, rex.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    expect(asked.task).toMatchObject({ status: 'waiting', panel: [rita.id, rex.id] });
  });

  it('takes the other verdicts while one reviewer waits for a person, and closes the gate once that one has given its own', async () => {
    const { app, ctx, db, ceo, bruno, rita, rex, hana, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    const { request } = await askedOfPerson(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    const other = await verdict(ctx, rex.id, task.id, { pass: true, comment: 'Tests cover it.' });
    expect(other.task).toMatchObject({ status: 'waiting', panel: [rita.id], assigneeAgentId: rita.id });
    await expect(verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' })).rejects.toMatchObject({ reason: 'task_invalid' });
    const answered = await app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: 'Yes, with tax.' }, ...as(ceo) });
    expect(answered.statusCode).toBe(200);
    expect((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ status: 'review', panel: [rita.id] });
    const last = await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Tax is in.' });
    expect(last.task.status).toBe('done');
    expect(last.wakes.map(w => [w.agentId, w.why])).toEqual([[hana.id, 'done']]);
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
    /* What to do is said once. */
    expect(await told(db, hana.id, 'Do that, or tell the CEO')).toBe(false);
    expect((await call(await tools(hana), 'update_task', { task: task.number, executor: bea.id })).isError).toBeFalsy();
    expect(await row(db, task.id)).toMatchObject({ assigneeAgentId: bea.id, executorAgentId: bea.id });
  });

  it('reminds the head holding such work to give it out, and a reviewer at a gate that waits for a person to give its verdict', async () => {
    const { ctx, db, hana, bruno, rita, rex, patch, memberTask } = await company();
    const task = await memberTask();
    await patch(bruno.id, { on: false });
    const held = await row(db, task.id);
    expect(wakePrompt(hana, held, { agentId: hana.id, taskId: task.id, why: 'reminder' })).toContain('update_task');
    await patch(bruno.id, { on: true });
    const other = await memberTask(rex.id, [rita.id]);
    await submit(ctx, rex.id, other.id, done);
    await askedOfPerson(ctx, rita.id, other.id, { kind: 'question', text: 'Is tax in scope?' });
    const waiting = await row(db, other.id);
    expect(waiting.status).toBe('waiting');
    expect(wakePrompt(rita, waiting, { agentId: rita.id, taskId: other.id, why: 'reminder' })).toContain('give your verdict');
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

  it('moves the work on when the last reviewer of the gate role at the gate is switched off', async () => {
    const { ctx, db, bruno, rita, rex, off, patch, memberTask } = await company();
    const task = await memberTask();
    await off(rex.id);
    await submit(ctx, bruno.id, task.id, done);
    await patch(rita.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ status: 'done', panel: [] });
  });

  it('switches the last reviewer off even when work under the task, from an older Hornhoof, keeps it from finishing', async () => {
    const { ctx, db, dev, bruno, rita, rex, off, patch, memberTask } = await company();
    const task = await memberTask();
    await off(rex.id);
    await submit(ctx, bruno.id, task.id, done);
    await db.insert(tasks).values({ companyId: dev.companyId, number: 99, title: 'Refunds', brief: '', body: '', departmentId: dev.id, parentId: task.id, assigneeAgentId: bruno.id, executorAgentId: bruno.id });
    expect((await patch(rita.id, { on: false })).statusCode).toBe(200);
    expect(await row(db, task.id)).toMatchObject({ status: 'review', stage: 1 });
  });

  it('moves work that waits with the head at a gate on once its whole role is switched off', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, unable, patch, memberTask } = await company();
    const task = await memberTask();
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, task.id, done);
    expect(await row(db, task.id)).toMatchObject({ status: 'review', panel: [], assigneeAgentId: hana.id });
    await patch(rita.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ status: 'done', panel: [] });
  });

  it('leaves a gate that waits for a person to the reviewer who asked', async () => {
    const { app, ctx, db, ceo, bruno, rita, rex, patch, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    const { request } = await askedOfPerson(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    await patch(rex.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ status: 'waiting', panel: [rita.id] });
    await app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: 'Yes, with tax.' }, ...as(ceo) });
    expect((await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Tax is in.' })).task.status).toBe('done');
  });

  it('hands the gate on once the answer comes for a reviewer that asked and was switched off meanwhile', async () => {
    const { app, ctx, db, ceo, bruno, rita, rex, patch, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    const { request } = await askedOfPerson(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    await patch(rita.id, { on: false });
    expect(await row(db, task.id)).toMatchObject({ status: 'waiting', panel: [rita.id, rex.id] });
    await app.inject({ method: 'POST', url: `/api/requests/${request.id}`, payload: { answer: 'Yes, with tax.' }, ...as(ceo) });
    expect(await row(db, task.id)).toMatchObject({ status: 'review', panel: [rex.id], assigneeAgentId: rex.id });
    expect(await db.select().from(jobs).where(and(eq(jobs.agentId, rita.id), eq(jobs.status, 'queued')))).toEqual([]);
  });

  it('wakes a reviewer whose answer came first again once the last question at the gate is answered', async () => {
    const { ctx, db, bruno, rita, rex, memberTask } = await company();
    const task = await memberTask();
    await submit(ctx, bruno.id, task.id, done);
    const first = await askedOfPerson(ctx, rita.id, task.id, { kind: 'question', text: 'Is tax in scope?' });
    const second = await askedOfPerson(ctx, rex.id, task.id, { kind: 'question', text: 'Which currency?' });
    const [ceo] = await db.select().from(people);
    const early = await answer(ctx, { personId: ceo!.id }, first.request.id, { answer: 'Yes, with tax.' });
    expect(early.task.status).toBe('waiting');
    expect(early.wakes.map(w => [w.agentId, w.why])).toEqual([[rita.id, 'answered']]);
    const last = await answer(ctx, { personId: ceo!.id }, second.request.id, { answer: 'Euro.' });
    expect(last.task.status).toBe('review');
    expect(last.wakes.map(w => [w.agentId, w.why])).toEqual([
      [rex.id, 'answered'],
      [rita.id, 'review'],
    ]);
  });

  /* Someone moves the other task in the moment between the switch reading the tasks and moving them. */
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
    onTestFinished(() => {
      ctx.bus.publish = publish;
    });
  };

  it('starts every waiting gate when a reviewer who can check is switched on while someone moves one of them', async () => {
    const { ctx, db, bruno, bea, rita, rex, off, unable, patch, memberTask } = await company();
    const one = await memberTask(bruno.id);
    const two = await memberTask(bea.id);
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, one.id, done);
    await submit(ctx, bea.id, two.id, done);
    meddle(ctx, db, [one.id, two.id]);
    await patch(rex.id, { on: true });
    for (const t of [one, two]) {
      expect(await row(db, t.id)).toMatchObject({ panel: [rex.id], assigneeAgentId: rex.id });
      expect((await db.select().from(jobs).where(and(eq(jobs.agentId, rex.id), eq(jobs.taskId, t.id)))).length).toBe(1);
    }
  });

  it('hands every task back when an agent is switched off while someone moves one of them', async () => {
    const { ctx, db, hana, bruno, patch, memberTask } = await company();
    const one = await memberTask();
    const two = await memberTask();
    meddle(ctx, db, [one.id, two.id]);
    await patch(bruno.id, { on: false });
    for (const t of [one, two]) expect((await row(db, t.id)).assigneeAgentId).toBe(hana.id);
  });

  it('keeps a reviewer at the gate whose question to a person comes in while it is switched off', async () => {
    const { ctx, db, companyId, bruno, bea, rita, patch, memberTask } = await company();
    const one = await memberTask(bruno.id);
    const two = await memberTask(bea.id);
    await submit(ctx, bruno.id, one.id, done);
    await submit(ctx, bea.id, two.id, done);
    meddle(ctx, db, [one.id, two.id], async other => {
      await db.insert(requests).values({ companyId, taskId: other, agentId: rita.id, kind: 'question', text: 'Is tax in scope?' });
      await db.update(tasks).set({ status: 'waiting', version: sql`${tasks.version} + 1` }).where(eq(tasks.id, other));
    });
    await patch(rita.id, { on: false });
    expect((await row(db, two.id)).panel).toContain(rita.id);
  });

  it('starts the gate again once one of its role who is on can check it', async () => {
    const { ctx, db, bruno, rita, rex, hana, off, unable, patch, memberTask } = await company();
    const task = await memberTask();
    await off(rex.id);
    await unable(rita.id);
    await submit(ctx, bruno.id, task.id, done);
    expect(await row(db, task.id)).toMatchObject({ status: 'review', stage: 1, panel: [], assigneeAgentId: hana.id });
    /* Rita is on but cannot check it; Rex can, so he checks it alone. */
    await patch(rex.id, { on: true });
    expect(await row(db, task.id)).toMatchObject({ status: 'review', stage: 1, panel: [rex.id], assigneeAgentId: rex.id });
    expect((await db.select().from(jobs).where(and(eq(jobs.agentId, rex.id), eq(jobs.taskId, task.id)))).length).toBe(1);
  });

  it('moves the company on to the next turn when the gate it leaves finishes the last task of the turn', async () => {
    const { ctx, db, companyId, bruno, rita, rex, patch, memberTask } = await company();
    const [turn] = await db.insert(turns).values({ companyId, number: 1, title: 'Payments', goal: 'Card payments.' }).returning();
    const task = await memberTask();
    expect(task.turnId).toBe(turn!.id);
    await submit(ctx, bruno.id, task.id, done);
    await verdict(ctx, rita.id, task.id, { pass: true, comment: 'Fine.' });
    await patch(rex.id, { on: false });
    expect((await row(db, task.id)).status).toBe('done');
    expect((await db.select().from(turns).where(eq(turns.id, turn!.id)))[0]!.status).toBe('closed');
  });
});
