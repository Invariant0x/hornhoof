import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { agentEvents, agents, companies, departments, jobs, nodes, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { restartCause } from '../src/modules/nodes/restarts.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { routeOf, routeSnapshot } from '../src/modules/tasks/echelons-store.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { taskWakeOf } from '../src/modules/tasks/wake-state.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const MACHINE_UP = '2026-11-01T08:00:00.000Z';

/* How a node came up: its program, the machine under it and its container. */
const boot = (startedAt: string, container = 'c0ffee000001', machineUpAt = MACHINE_UP) => ({ startedAt, machineUpAt, container });

/* The node's mark comes back after every message it sent before was handled, one after the other as its socket keeps them. */
async function marked(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}

type Run = { type: 'job.run'; jobId: string; prompt: string };
async function nextRun(node: FakeNode): Promise<Run> {
  for (;;) {
    const m = await node.next();
    if (m.type === 'job.run') return m as Run;
  }
}

/* A company on the built-in node: Development with Hana at its head and Bruno, and Operations with its head Olga and Rob,
   its reliability engineer. The node said how it came up once already, so Hornhoof can tell what changed. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [sub] = await db.select().from(subscriptions);
  let node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], boot: boot('2026-11-03T00:00:00.000Z') });
  await until(async () => (await db.select().from(subscriptions))[0]!.status === 'ready');
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null, null, BUILTIN)!));
  const dept = async (templateKey: 'development' | 'operations', roleCode: string) => (await db.insert(departments).values({ companyId, templateKey, roleCode }).returning())[0]!;
  const [dev, ops] = [await dept('development', 'DEV'), await dept('operations', 'OPS')];
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-ENG', dev.id);
  const olga = await hire('Olga', 'head', 'OPS-HEAD', ops.id);
  const rob = await hire('Rob', 'worker', 'OPS-FIX', ops.id);
  const ctx = app.ctx;
  const task = (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code' })).task;
  const turnsOf = (agentId: string) => db.select().from(jobs).where(eq(jobs.agentId, agentId)).orderBy(asc(jobs.createdAt));
  const jobOf = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
  const notes = () => db.select().from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'interrupted'))).orderBy(asc(taskEvents.id));
  /* The node starts again as said and greets Hornhoof with the turns it still runs: none. */
  const restart = async (how: ReturnType<typeof boot>) => {
    node.close();
    await node.closed;
    node = await connectNode(url, NODE_KEY);
    node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], boot: how });
    return node;
  };
  /* Bruno's turn on his task goes out to the node. */
  const brunoAtWork = async () => {
    await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
    return nextRun(node);
  };
  return { app, db, ctx, ceo, companyId, sub: sub!, node: () => node, hana, bruno, olga, rob, task, turnsOf, jobOf, notes, restart, brunoAtWork };
}

describe('a turn cut off by a node restart', () => {
  it.each(['done', 'reported', 'reviewed'] as const)('still delivers a %s notice to the giver and retries it after a restart', async why => {
    const c = await company();
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    await wakeAll(c.ctx, [{ agentId: c.hana.id, taskId: c.task.id, why, text: 'Checked.' }]);
    const first = await nextRun(c.node());
    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));
    expect(await c.jobOf(retry.jobId)).toMatchObject({ agentId: c.hana.id, taskId: c.task.id, retryOf: first.jobId, status: 'running' });
    expect((await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id))).filter(e => e.kind === 'wake_skipped')).toEqual([]);
    expect(await c.turnsOf(c.bruno.id)).toEqual([]);
  });

  it.each(['done', 'cancelled'] as const)('skips a restart after the running task became %s, with a task log line and no wake', async status => {
    const c = await company();
    const first = await c.brunoAtWork();
    await c.db.update(tasks).set({ status, closedAt: new Date(), assigneeAgentId: null }).where(eq(tasks.id, c.task.id));
    await c.restart(boot('2026-11-03T00:11:00.000Z', 'c0ffee000001', '2026-11-03T00:09:00.000Z'));
    await until(() => c.ctx.hub.isReady(BUILTIN));
    const log = await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id));
    expect(log.filter(e => e.kind === 'wake_skipped')).toEqual([expect.objectContaining({ agentId: c.bruno.id, text: expect.stringContaining('task is already closed'), data: expect.objectContaining({ job: first.jobId, wake: 'restart' }) })]);
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([first.jobId]);
    expect([...(await c.turnsOf(c.hana.id)), ...(await c.turnsOf(c.rob.id)), ...(await c.turnsOf(c.olga.id))]).toEqual([]);
    expect(log.filter(e => e.kind === 'interrupted')).toEqual([]);
  });

  it('does not call Operations when a retry was cut off after the task closed', async () => {
    const c = await company();
    await c.brunoAtWork();
    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));
    await c.db.update(tasks).set({ status: 'done', closedAt: new Date() }).where(eq(tasks.id, c.task.id));
    await c.restart(boot('2026-11-03T00:20:00.000Z'));
    await until(() => c.ctx.hub.isReady(BUILTIN));
    expect([...(await c.turnsOf(c.rob.id)), ...(await c.turnsOf(c.olga.id))]).toEqual([]);
    expect((await c.db.select().from(taskEvents).where(eq(taskEvents.taskId, c.task.id))).filter(e => e.kind === 'wake_skipped')).toEqual([expect.objectContaining({ data: { job: retry.jobId, wake: 'restart' } })]);
  });

  it.each([null, ''])('repeats a turn with requested text %j using the legacy sent text only for null', async requestedPrompt => {
    const c = await company();
    const first = await c.brunoAtWork();
    await c.db.update(jobs).set({ requestedPrompt, prompt: 'Legacy sent work.' }).where(eq(jobs.id, first.jobId));

    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));

    expect(retry.prompt.includes('Legacy sent work.')).toBe(requestedPrompt === null);
    expect(retry.prompt).toContain('Hornhoof runs it once more');
  });

  it('adds the catch-up once and no repository when it repeats the requested work', async () => {
    const c = await company();
    await c.db.update(departments).set({ repoUrl: 'https://example.com/checkout.git', repoBranch: 'main' }).where(eq(departments.id, c.task.departmentId!));
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.bruno.id, kind: 'text', data: { text: 'Earlier checkout discussion.' } });
    const first = await c.brunoAtWork();
    expect(first.prompt.match(/Earlier in this conversation/g)).toHaveLength(1);
    expect(first.prompt).not.toContain('checkout.git');
    await c.db.update(departments).set({ repoBranch: 'checkout' }).where(eq(departments.id, c.task.departmentId!));

    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));

    expect(retry.prompt.match(/Earlier in this conversation/g)).toHaveLength(1);
    expect(retry.prompt).not.toContain('checkout.git');
    expect(retry.prompt).not.toContain('(branch');
    expect(retry.prompt).toContain(`#${c.task.number} "Checkout API" is yours to do`);
    const kept = await c.jobOf(first.jobId);
    expect(kept).toMatchObject({ prompt: first.prompt, requestedPrompt: expect.stringContaining('is yours to do') });
    expect(kept).toHaveProperty('requestedPrompt', expect.not.stringContaining('checkout.git'));
    expect(kept).toHaveProperty('requestedPrompt', expect.not.stringContaining('Earlier in this conversation'));
    expect(await c.jobOf(retry.jobId)).toMatchObject({ prompt: retry.prompt, retryOf: first.jobId });
  });

  it('keeps why, when, where, its task and turn, and runs the turn once more, linked to the one cut off', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    const node = await c.restart(boot('2026-11-03T00:11:00.000Z'));
    await until(async () => (await c.jobOf(first.jobId)).status === 'failed');
    const cut = await c.jobOf(first.jobId);
    expect(cut.error).toBe('machine_restarted');
    expect(cut.interruption).toMatchObject({ cause: 'program', task: c.task.number, node: { id: null, name: 'the built-in node' } });
    expect(Date.parse(cut.interruption!.at)).not.toBeNaN();
    /* Once, linked to the turn it repeats, with what that turn was asked. */
    const retry = await nextRun(node);
    const turns = await c.turnsOf(c.bruno.id);
    expect(turns.map(j => ({ id: j.id, taskId: j.taskId, retryOf: j.retryOf }))).toEqual([
      { id: first.jobId, taskId: c.task.id, retryOf: null },
      { id: retry.jobId, taskId: c.task.id, retryOf: first.jobId },
    ]);
    expect(retry.prompt).toContain('restarted');
    expect(retry.prompt).toContain(`#${c.task.number} "Checkout API" is yours to do`);
    /* The employee's window shows the retry once, from Hornhoof. */
    const shown = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, retry.jobId), eq(agentEvents.kind, 'message')));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.personId).toBeNull();
    expect((shown[0]!.data as { text: string }).text).toContain('Hornhoof runs it once more');
    /* The task's log says it, for people and for agents that read the task. */
    const [note] = await c.notes();
    expect(note).toMatchObject({ agentId: c.bruno.id, data: { job: first.jobId, cause: 'program', retry: { job: retry.jobId, n: 1, of: 1 } } });
    expect(note!.text).toContain(first.jobId);
    expect(note!.text).toContain('retry 1 of 1');
  });

  it('runs no third turn when the retry is cut off too, and calls the reliability engineer with both restarts', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    const again = await c.restart(boot('2026-11-03T00:11:00.000Z'));
    const retry = await nextRun(again);
    await c.restart(boot('2026-11-03T00:20:00.000Z', 'c0ffee000002'));
    await until(async () => (await c.jobOf(retry.jobId)).status === 'failed');
    const cut = (await c.jobOf(retry.jobId)).interruption!;
    expect(cut).toMatchObject({ cause: 'container', task: c.task.number });
    /* Nothing more of Bruno's on the task: the two turns, and the task stays his. */
    await until(async () => (await c.turnsOf(c.rob.id)).length === 1);
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([first.jobId, retry.jobId]);
    const [held] = await c.db.select().from(tasks).where(eq(tasks.id, c.task.id));
    expect(held).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id });
    expect(['open', 'working']).toContain(held!.status);
    /* Rob hears who, which task, where, both causes and when, from Hornhoof. */
    const [call] = await c.turnsOf(c.rob.id);
    expect(call).toBeDefined();
    for (const said of ['Bruno', `#${c.task.number}`, 'the built-in node', first.jobId, retry.jobId, cut.at.slice(0, 10), 'started again', 'created again']) expect(call!.prompt).toContain(said);
    const [shown] = await c.db.select().from(agentEvents).where(and(eq(agentEvents.jobId, call!.id), eq(agentEvents.kind, 'message')));
    expect(shown!.data).not.toHaveProperty('from');
    expect(shown!.personId).toBeNull();
    /* The task's log says Rob was called. */
    const notes = await c.notes();
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatchObject({ agentId: c.bruno.id, data: { job: retry.jobId, cause: 'container', first: { job: first.jobId, cause: 'program' }, called: { id: c.rob.id, name: 'Rob' } } });
    expect(notes[1]!.text).toContain('Rob');
  });

  it("calls the head of Operations when its reliability engineer is off", async () => {
    const c = await company();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(eq(agents.id, c.rob.id));
    await c.brunoAtWork();
    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));
    await c.restart(boot('2026-11-03T00:20:00.000Z'));
    await until(async () => (await c.jobOf(retry.jobId)).status === 'failed');
    await until(async () => (await c.turnsOf(c.olga.id)).length === 1);
    expect(await c.turnsOf(c.rob.id)).toEqual([]);
    expect((await c.notes())[1]).toMatchObject({ data: { called: { id: c.olga.id, name: 'Olga' } } });
  });

  it('lets the turn that already waits on the task be the retry, rather than queue one more', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    const [waiting] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.bruno.id, taskId: c.task.id, kind: 'conversation', prompt: 'Hana answered your question.', timeoutMs: 60_000 }).returning();
    const [task] = await c.db.select().from(tasks).where(eq(tasks.id, c.task.id));
    const taskWake = taskWakeOf(task!, { why: 'go_on' }, routeSnapshot(await routeOf(c.db, task!), task!.assigneeAgentId));
    await c.db.insert(agentEvents).values({ companyId: c.companyId, agentId: c.bruno.id, jobId: waiting!.id, kind: 'message', data: { text: 'Hana answered your question.', taskWake } });
    const node = await c.restart(boot('2026-11-03T00:11:00.000Z'));
    const retry = await nextRun(node);
    expect(retry.jobId).toBe(waiting!.id);
    expect(retry.prompt).toContain('Hornhoof runs it once more');
    expect(retry.prompt).toContain('Hana answered your question.');
    expect((await c.turnsOf(c.bruno.id)).map(j => ({ id: j.id, retryOf: j.retryOf }))).toEqual([
      { id: first.jobId, retryOf: null },
      { id: waiting!.id, retryOf: first.jobId },
    ]);
    expect((await c.notes())[0]).toMatchObject({ data: { retry: { job: waiting!.id, n: 1, of: 1 } } });
  });

  it('says in the log that the turn could not run again when its agent has no subscription', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    await c.db.update(agents).set({ subscriptionId: null }).where(eq(agents.id, c.bruno.id));
    await c.restart(boot('2026-11-03T00:11:00.000Z'));
    await until(async () => (await c.notes()).length === 1);
    const [note] = await c.notes();
    expect(note).toMatchObject({ data: { job: first.jobId, retry: null } });
    expect(note!.text).toContain('could not run it again');
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([first.jobId]);
  });

  it('says in the log that nobody in Operations is on, and wakes nobody, when both of them are off', async () => {
    const c = await company();
    await c.db.update(agents).set({ switchedOffAt: new Date() }).where(inArray(agents.id, [c.rob.id, c.olga.id]));
    await c.brunoAtWork();
    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));
    await c.restart(boot('2026-11-03T00:20:00.000Z'));
    await until(async () => (await c.notes()).length === 2);
    const second = (await c.notes())[1]!;
    expect(second).toMatchObject({ data: { job: retry.jobId, called: null } });
    expect(second.text).toContain('nobody in Operations is on');
    expect([...(await c.turnsOf(c.rob.id)), ...(await c.turnsOf(c.olga.id))]).toEqual([]);
  });

  it('goes on as before after a turn that ended with another error', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    c.node().send({ type: 'job.done', jobId: first.jobId, ok: false, result: 'The program exited with code 1.', sessionId: null, tail: '', error: 'agent_failed' });
    await until(async () => (await c.jobOf(first.jobId)).status === 'failed');
    /* No restart: the turn goes on as one whose program failed before it recorded its work does, linked to it by continueOf. */
    const next = await nextRun(c.node());
    expect(next.prompt).toContain('without recording');
    const turns = await c.turnsOf(c.bruno.id);
    expect(turns.map(j => j.retryOf)).toEqual([null, null]);
    expect(turns.map(j => j.continueOf)).toEqual([null, first.jobId]);
    expect(turns[0]!.interruption).toBeNull();
    expect(await c.notes()).toEqual([]);
    expect((await c.db.select(only(taskEvents, 'kind')).from(taskEvents).where(eq(taskEvents.taskId, c.task.id))).map(e => e.kind)).toContain('continued');
  });

  it("shows the turns a node restart cut off on the employee's card, the latest first", async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    const retry = await nextRun(await c.restart(boot('2026-11-03T00:11:00.000Z')));
    await c.restart(boot('2026-11-03T00:20:00.000Z', 'c0ffee000002'));
    await until(async () => (await c.jobOf(retry.jobId)).status === 'failed');
    const card = (await c.app.inject({ url: `/api/agents/${c.bruno.id}`, ...as(c.ceo) })).json();
    expect(card.interrupted).toEqual([
      { job: retry.jobId, at: expect.any(String), cause: 'container', node: null, task: { id: c.task.id, number: c.task.number }, retry: true },
      { job: first.jobId, at: expect.any(String), cause: 'program', node: null, task: { id: c.task.id, number: c.task.number }, retry: false },
    ]);
  });

  it('keeps why a turn without a task was cut off, and leaves it to its next round', async () => {
    const c = await company();
    const [timer] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.rob.id, kind: 'conversation', prompt: 'Your round.', timeoutMs: 60_000, status: 'running', startedAt: new Date() }).returning();
    await c.restart(boot('2026-11-03T00:11:00.000Z'));
    await until(async () => (await c.jobOf(timer!.id)).status === 'failed');
    expect((await c.jobOf(timer!.id)).interruption).toMatchObject({ cause: 'program', task: null });
    /* The node's hello, which ended the turn and would have queued its retry, has been handled to its end. */
    await marked(c.node());
    expect((await c.turnsOf(c.rob.id)).map(j => j.id)).toEqual([timer!.id]);
  });
});

/* A fresh server context on the same database, as after the server's process ended. */
async function restartServer(app: FastifyInstance) {
  const { db, config } = app.ctx;
  await app.close();
  const next = await buildApp({ db, config });
  onTestFinished(() => next.close());
  return { app: next, url: await listen(next) };
}

async function builtinHello(url: string, how?: ReturnType<typeof boot>, running: string[] = []) {
  const node = await connectNode(url, NODE_KEY);
  node.send({ type: 'hello', version: '0.5.0', loggedIn: true, running, boot: how });
  return node;
}

describe('a built-in turn cut off by a server restart', () => {
  it.each([
    { name: 'with boot information', how: boot('2026-11-03T00:11:00.000Z') },
    { name: 'without boot information', how: undefined },
  ])('names the server restart and retries once, $name', async ({ how }) => {
    const c = await company();
    const first = await c.brunoAtWork();
    const next = await restartServer(c.app);
    const node = await builtinHello(next.url, how);
    const retry = await nextRun(node);

    const cut = await c.jobOf(first.jobId);
    expect(cut).toMatchObject({ status: 'failed', error: 'machine_restarted', interruption: { cause: 'server', task: c.task.number, node: { id: null, name: 'the built-in node' } } });
    expect(Date.parse(cut.interruption!.at)).not.toBeNaN();
    expect((await c.turnsOf(c.bruno.id)).map(j => ({ id: j.id, retryOf: j.retryOf }))).toEqual([
      { id: first.jobId, retryOf: null },
      { id: retry.jobId, retryOf: first.jobId },
    ]);
    expect(retry.prompt).toContain('the Hornhoof server started again');
    const [note] = await c.notes();
    expect(note).toMatchObject({ data: { job: first.jobId, cause: 'server', retry: { job: retry.jobId, n: 1, of: 1 } } });
    for (const said of [first.jobId, `#${c.task.number}`, 'the Hornhoof server started again', 'retry 1 of 1']) expect(note!.text).toContain(said);
    const card = (await next.app.inject({ url: `/api/agents/${c.bruno.id}`, ...as(c.ceo) })).json();
    expect(card.interrupted).toEqual([{ job: first.jobId, at: cut.interruption!.at, cause: 'server', node: null, task: { id: c.task.id, number: c.task.number }, retry: false }]);
    expect(await c.db.select().from(nodes)).toEqual([]);
  });

  it('does not retry a second server restart and calls Operations with both turns', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    const again = await restartServer(c.app);
    const retry = await nextRun(await builtinHello(again.url));
    const next = await restartServer(again.app);
    await builtinHello(next.url);
    await until(async () => (await c.notes()).length === 2);

    expect((await c.turnsOf(c.bruno.id)).map(j => ({ id: j.id, status: j.status, retryOf: j.retryOf }))).toEqual([
      { id: first.jobId, status: 'failed', retryOf: null },
      { id: retry.jobId, status: 'failed', retryOf: first.jobId },
    ]);
    const notes = await c.notes();
    expect(notes[1]).toMatchObject({ data: { job: retry.jobId, cause: 'server', first: { job: first.jobId, cause: 'server' }, called: { id: c.rob.id, name: 'Rob' } } });
    const [call] = await c.turnsOf(c.rob.id);
    for (const said of [first.jobId, retry.jobId, `#${c.task.number}`, 'the Hornhoof server started again', 'does not run the turn a third time']) expect(call!.prompt).toContain(said);
    expect((await c.db.select().from(tasks).where(eq(tasks.id, c.task.id)))[0]).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id });
  });

  it('does not retry timers or end turns the built-in node still reports', async () => {
    const c = await company();
    const [timer, kept] = await c.db.insert(jobs).values([
      { companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.rob.id, kind: 'conversation', prompt: 'Your round.', timeoutMs: 60_000, status: 'running', startedAt: new Date() },
      { companyId: c.companyId, subscriptionId: c.sub.id, agentId: c.hana.id, kind: 'conversation', prompt: 'Still working.', timeoutMs: 60_000, status: 'running', startedAt: new Date() },
    ]).returning();
    const next = await restartServer(c.app);
    await builtinHello(next.url, undefined, [kept!.id]);
    await until(() => next.app.ctx.hub.isReady(BUILTIN));

    expect(await c.jobOf(timer!.id)).toMatchObject({ status: 'failed', interruption: { cause: 'server', task: null } });
    expect((await c.turnsOf(c.rob.id)).map(j => j.id)).toEqual([timer!.id]);
    expect(await c.jobOf(kept!.id)).toMatchObject({ status: 'running', interruption: null });
  });

  it.each([
    { name: 'with a known boot', before: boot('2026-11-03T00:00:00.000Z'), cause: 'program' },
    { name: 'without a known boot', before: null, cause: 'unknown' },
  ])('keeps a machine hello before the built-in node separate, $name', async ({ before, cause }) => {
    const c = await company();
    const first = await c.brunoAtWork();
    const connected = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(c.ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } });
    const personal = joined.json().nodes[0];
    await c.db.update(nodes).set({ version: '0.5.0', boot: before }).where(eq(nodes.id, personal.nodeId));
    const [machineJob] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: personal.subscriptionId, nodeId: personal.nodeId, kind: 'test', prompt: 'Check.', timeoutMs: 60_000, status: 'running' }).returning();
    const next = await restartServer(c.app);
    const machine = await connectNode(next.url, personal.key);
    machine.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], boot: boot('2026-11-03T00:11:00.000Z') });
    await until(async () => (await c.jobOf(machineJob!.id)).status === 'failed');

    expect((await c.jobOf(machineJob!.id)).interruption).toMatchObject({ cause, node: { id: personal.nodeId, name: 'dev-mac' } });
    expect((await c.jobOf(first.jobId)).status).toBe('running');
    const retry = await nextRun(await builtinHello(next.url));
    expect((await c.jobOf(first.jobId)).interruption).toMatchObject({ cause: 'server', task: c.task.number });
    expect((await c.jobOf(retry.jobId)).retryOf).toBe(first.jobId);
  });
});

describe('why a node restarted', () => {
  const before = { version: '0.5.0', boot: boot('2026-11-03T00:00:00.000Z') };
  const now = (b: ReturnType<typeof boot>, version = '0.5.0') => ({ version, boot: b });

  it('tells an update, a machine that started again, a new container, a program that started again and a lost connection', () => {
    expect(restartCause(before, now(boot('2026-11-03T00:11:00.000Z', 'c0ffee000002'), '0.6.0'))).toBe('update');
    expect(restartCause(before, now(boot('2026-11-03T00:11:00.000Z', 'c0ffee000001', '2026-11-03T00:09:00.000Z')))).toBe('machine');
    expect(restartCause(before, now(boot('2026-11-03T00:11:00.000Z', 'c0ffee000002')))).toBe('container');
    expect(restartCause(before, now(boot('2026-11-03T00:11:00.000Z')))).toBe('program');
    expect(restartCause(before, now(boot('2026-11-03T00:00:00.000Z')))).toBe('connection');
  });

  it('does not take a clock a few seconds off for a machine that started again', () => {
    expect(restartCause(before, now(boot('2026-11-03T00:11:00.000Z', 'c0ffee000001', '2026-11-01T08:00:05.000Z')))).toBe('program');
  });

  it('says it does not know when the node never said how it came up, before or now', () => {
    expect(restartCause(null, now(boot('2026-11-03T00:11:00.000Z')))).toBe('unknown');
    expect(restartCause({ version: '0.5.0', boot: null }, now(boot('2026-11-03T00:11:00.000Z')))).toBe('unknown');
    expect(restartCause(before, { version: '0.5.0' })).toBe('unknown');
  });
});
