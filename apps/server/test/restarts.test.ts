import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, subscriptions, taskEvents, tasks } from '../src/db/schema.js';
import { identityOf } from '../src/modules/nodes/hub.js';
import { restartCause } from '../src/modules/nodes/restarts.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { as, connectNode, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const MACHINE_UP = '2026-11-01T08:00:00.000Z';

/* How a node came up: its program, the machine under it and its container. */
const boot = (startedAt: string, container = 'c0ffee000001', machineUpAt = MACHINE_UP) => ({ startedAt, machineUpAt, container });

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
  await until(() => app.ctx.hub.isReady(identityOf(sub!, null)));
  const dept = async (templateKey: 'development' | 'operations', roleCode: string) => (await db.insert(departments).values({ companyId, templateKey, roleCode }).returning())[0]!;
  const [dev, ops] = [await dept('development', 'DEV'), await dept('operations', 'OPS')];
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string, departmentId: string) =>
    (await db.insert(agents).values({ companyId, kind, name, roleKey, departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD', dev.id);
  const bruno = await hire('Bruno', 'worker', 'DEV-ENG', dev.id);
  const olga = await hire('Olga', 'head', 'OPS-HEAD', ops.id);
  const rob = await hire('Rob', 'worker', 'OPS-FIX', ops.id);
  const ctx = app.ctx;
  const task = (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev.id, assigneeAgentId: bruno.id, executor: true })).task;
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
    expect((await c.jobOf(retry.jobId)).interruption).toMatchObject({ cause: 'container', task: c.task.number });
    /* Nothing more of Bruno's on the task: the two turns, and the task stays his. */
    await new Promise(r => setTimeout(r, 100));
    expect((await c.turnsOf(c.bruno.id)).map(j => j.id)).toEqual([first.jobId, retry.jobId]);
    const [held] = await c.db.select().from(tasks).where(eq(tasks.id, c.task.id));
    expect(held).toMatchObject({ assigneeAgentId: c.bruno.id, executorAgentId: c.bruno.id });
    expect(['open', 'working']).toContain(held!.status);
    /* Rob hears who, which task, where, both causes and when, from Hornhoof. */
    const [call] = await c.turnsOf(c.rob.id);
    expect(call).toBeDefined();
    for (const said of ['Bruno', `#${c.task.number}`, 'the built-in node', first.jobId, retry.jobId, '2026-11-03', 'started again', 'created again']) expect(call!.prompt).toContain(said);
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

  it('goes on as before after a turn that ended with another error', async () => {
    const c = await company();
    const first = await c.brunoAtWork();
    c.node().send({ type: 'job.done', jobId: first.jobId, ok: false, result: 'The program exited with code 1.', sessionId: null, tail: '', error: 'agent_failed' });
    await until(async () => (await c.jobOf(first.jobId)).status === 'failed');
    const next = await nextRun(c.node());
    expect(next.prompt).toContain('ended before the work did');
    const turns = await c.turnsOf(c.bruno.id);
    expect(turns.map(j => j.retryOf)).toEqual([null, null]);
    expect(turns[0]!.interruption).toBeNull();
    expect(await c.notes()).toEqual([]);
    expect((await c.db.select({ kind: taskEvents.kind }).from(taskEvents).where(eq(taskEvents.taskId, c.task.id))).map(e => e.kind)).toContain('continued');
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
    await new Promise(r => setTimeout(r, 100));
    expect((await c.turnsOf(c.rob.id)).map(j => j.id)).toEqual([timer!.id]);
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
