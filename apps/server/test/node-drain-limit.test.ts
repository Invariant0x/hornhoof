import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agentInbox, agents, companies, departments, jobs, machines, nodes, people, subscriptions } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { enqueueTurn, orchestratorOf } from '../src/modules/conversation/queue.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { wakeAll } from '../src/modules/tasks/wake.js';
import { nodeDrain } from '../src/modules/updates/node-drain.js';
import { connectNode, listen, setUpCompany, TEST_SECRET, testApp, until, type FakeNode } from './helpers.js';

/* 19.11: a node waited three hours for its update behind one long, live turn, and the sixteen employees of its plan took
   no work meanwhile. A wait for an update holds new turns for a bounded time: past it the node updates, and the turn it
   cut runs once more after the restart, as after any restart. Half an hour into the wait, the orchestrator hears of it once. */

const MINUTE = 60_000;
/* The longest a node's wait for its update holds new turns, unless set otherwise. */
const LIMIT = 45 * MINUTE;
const NOTICE_AFTER = 30 * MINUTE;
/* The server looks at the nodes that wait once a second. */
const ROUND = 1000;
const BOOT = { startedAt: '2026-11-19T15:00:00.000Z', machineUpAt: '2026-11-19T09:00:00.000Z', container: 'first' };
const NEW_BOOT = { ...BOOT, startedAt: '2026-11-19T16:00:00.000Z', container: 'second' };

type Run = Extract<ServerMessage, { type: 'job.run' }>;

/* One plan on one machine, as on 19.11: its only node runs every employee of the plan, the orchestrator's turns too. The
   server's clock and rounds go only as far as a test moves them. */
async function onePlan(env: NodeJS.ProcessEnv = {}) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-19T15:10:00.000Z'));
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp({ NODE_KEY: 'builtin-limit-key-0123456789abcdef', HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-node-limit-')), ...env });
  await setUpCompany(app);
  const url = await listen(app);
  const ctx = app.ctx;
  const [company] = await db.select().from(companies);
  const companyId = company!.id;
  const [person] = await db.select(idOnly(people)).from(people);
  const [machine] = await db.insert(machines).values({ companyId, personId: person!.id, machineKey: 'limit-machine-key', hostname: 'studio-box' }).returning();
  const [plan] = await db.insert(subscriptions).values({ companyId, provider: 'claude', kind: 'personal', label: 'Claude', ownerPersonId: person!.id, status: 'ready' }).returning();
  const key = 'plan-node-limit-key-0123456789abcdef';
  const [row] = await db.insert(nodes).values({ companyId, machineId: machine!.id, subscriptionId: plan!.id, keyHash: hashToken(key), status: 'ready', version: '0.7.0' }).returning();
  const nodeId = row!.id;
  const id = { kind: 'node' as const, nodeId };
  const [dev] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV', repoUrl: 'https://example.com/shop.git', repoBranch: 'main' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', roleKey: string) =>
    (await db.insert(agents).values({ companyId, departmentId: dev!.id, subscriptionId: plan!.id, nodeId, kind, model: '', roleKey, name }).returning())[0]!;
  const hana = await hire('Hana', 'head', 'DEV-HEAD');
  const bruno = await hire('Bruno', 'worker', 'DEV-ENG');
  const cleo = await hire('Cleo', 'worker', 'DEV-ENG');
  const orchestrator = (await orchestratorOf(ctx, companyId))!;
  await db.update(agents).set({ subscriptionId: plan!.id, nodeId }).where(eq(agents.id, orchestrator.id));
  const task = (await createTask(ctx, { agentId: hana.id }, { title: 'Checkout API', brief: '', body: 'POST /checkout.', departmentId: dev!.id, assigneeAgentId: bruno.id, executor: true, resultKind: 'code' })).task;

  /* Every turn the node got, by its id, whichever test waits for which. */
  const runs = new Map<string, Run>();
  let node: FakeNode = await connectNode(url, key);
  onTestFinished(() => node.close());
  node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], boot: BOOT });
  await until(() => ctx.hub.isReady(id));
  const runOf = async (which: (run: Run) => boolean | Promise<boolean>): Promise<Run> => {
    for (const run of runs.values()) if (await which(run)) return run;
    for (;;) {
      const message = await node.next();
      if (message.type !== 'job.run') continue;
      runs.set(message.jobId, message);
      if (await which(message)) return message;
    }
  };
  const jobOf = async (jobId: string) => (await db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;

  /* Bruno's session goes on from a turn he finished on this node; then his long turn on his task goes out, in it. */
  const hello = await enqueueTurn(ctx, { companyId, agentId: bruno.id, prompt: 'Read the checkout notes.', createdBy: null });
  await runOf(run => run.jobId === hello);
  node.send({ type: 'job.done', jobId: hello, ok: true, sessionId: 'session-of-bruno', result: 'Read.', tail: '', error: null });
  await until(async () => (await jobOf(hello)).status === 'done');
  await wakeAll(ctx, [{ agentId: bruno.id, taskId: task.id, why: 'assigned' }]);
  const long = await runOf(async run => (await jobOf(run.jobId)).taskId === task.id);
  await until(async () => (await jobOf(long.jobId)).status === 'running');

  const ask = async () => (await app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${key}` }, payload: {} })).json();
  /* The clock goes on with no round between, as over a long turn. The node is heard from all along, and the updater, which
     asks every few seconds, asks again; then a round of the server goes. */
  const later = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms);
    node.send({ type: 'status', loggedIn: true, limits: null });
    await until(() => ctx.hub.lastSeenAt(id) === Date.now());
    const answer = await ask();
    await vi.advanceTimersByTimeAsync(ROUND);
    return answer;
  };
  /* The updater replaced the node: it comes back from the update with a new build and runs nothing. */
  const updated = async () => {
    node.close();
    await node.closed;
    node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.7.1', loggedIn: true, running: [], boot: NEW_BOOT });
    await until(() => ctx.hub.isReady(id) && nodeDrain(ctx, id) === null);
  };
  const turnFor = (agentId: string, prompt: string) => enqueueTurn(ctx, { companyId, agentId, prompt, createdBy: null });
  const notices = () => db.select().from(agentInbox).where(and(eq(agentInbox.agentId, orchestrator.id), eq(agentInbox.source, 'machine')));
  return { app, db, ctx, id, nodeId, task, hana, bruno, cleo, orchestrator, long, runs, runOf, jobOf, ask, later, updated, turnFor, notices };
}

describe("a node's wait for its update", () => {
  it('holds new turns for 45 minutes unless set otherwise', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET })).toMatchObject({ nodeUpdateWaitMs: LIMIT });
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_UPDATE_WAIT_MS: '600000' })).toMatchObject({ nodeUpdateWaitMs: 600_000 });
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_UPDATE_WAIT_MS: 'soon' })).toThrow(/NODE_UPDATE_WAIT_MS/);
  });

  it("does not hold the other employees' turns past its limit behind one long live turn", async () => {
    const p = await onePlan();
    expect(await p.ask()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });
    const held = [await p.turnFor(p.cleo.id, 'Write the refund tests.'), await p.turnFor(p.orchestrator.id, 'How is the checkout going?')];

    /* Up to the limit the wait holds them, and Bruno's turn goes on. */
    expect(await p.later(LIMIT - MINUTE)).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });
    for (const jobId of held) expect(await p.jobOf(jobId)).toMatchObject({ status: 'queued' });
    expect(await p.jobOf(p.long.jobId)).toMatchObject({ status: 'running', error: null });

    /* At the limit the updater hears the node is free, though the turn goes on. */
    expect(await p.later(MINUTE)).toMatchObject({ ready: true, free: ['self'], drain: { state: 'restarting' } });
    await p.updated();

    for (const jobId of held) await p.runOf(run => run.jobId === jobId);
    for (const jobId of held) expect(await p.jobOf(jobId)).toMatchObject({ status: 'running', nodeId: p.nodeId });
  });

  it('runs the turn it cut once more after the restart, on its task, in its session and its workspace', async () => {
    const p = await onePlan();
    expect(p.long.sessionId).toBe('session-of-bruno');
    expect(p.long.workspace?.repo).toMatchObject({ url: 'https://example.com/shop.git' });
    await p.ask();
    await p.later(LIMIT - MINUTE);
    expect((await p.later(MINUTE)).ready).toBe(true);

    await p.updated();

    expect(await p.jobOf(p.long.jobId)).toMatchObject({ status: 'failed', error: 'machine_restarted', interruption: expect.objectContaining({ cause: 'update' }) });
    const retry = await p.runOf(async run => (await p.jobOf(run.jobId)).retryOf === p.long.jobId);
    expect(await p.jobOf(retry.jobId)).toMatchObject({ agentId: p.bruno.id, taskId: p.task.id, status: 'running', nodeId: p.nodeId });
    expect(retry.sessionId).toBe('session-of-bruno');
    expect(retry.workspace).toEqual(p.long.workspace);
    expect(retry.prompt).toContain('Hornhoof runs it once more');
  });

  it('tells the orchestrator once, half an hour in, which node waits, since when and for which turns', async () => {
    const p = await onePlan();
    const since = new Date().toISOString();
    await p.ask();
    await p.later(NOTICE_AFTER - MINUTE);
    expect(await p.notices()).toEqual([]);

    /* The round and the updater's ask that see the half hour pass have told the orchestrator by the time they end. */
    await p.later(MINUTE);
    for (let round = 0; round < 5; round++) await p.later(2 * MINUTE);

    const letters = await p.notices();
    expect(letters).toHaveLength(1);
    const [notice] = letters;
    expect(notice!.text).toContain('studio-box');
    expect(notice!.text).toContain(p.nodeId);
    expect(notice!.text).toContain(since);
    expect(notice!.text).toContain(`Bruno on #${p.task.number}`);
    expect(notice!.text).toContain(p.long.jobId);
    expect(notice).toMatchObject({ kind: 'notification', senderKind: 'hornhoof' });
  });

  it('lets a node whose work ends within the limit update as before, and tells nobody', async () => {
    const p = await onePlan();
    await p.ask();
    await p.later(20 * MINUTE);
    p.runs.clear();
    await p.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, p.long.jobId));
    expect(await p.later(ROUND)).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    await p.updated();
    vi.setSystemTime(Date.now() + NOTICE_AFTER);
    await vi.advanceTimersByTimeAsync(ROUND);

    expect(await p.notices()).toEqual([]);
    expect(await p.jobOf(p.long.jobId)).toMatchObject({ status: 'done', error: null });
    expect(await p.db.select().from(jobs).where(eq(jobs.retryOf, p.long.jobId))).toEqual([]);
  });
});
