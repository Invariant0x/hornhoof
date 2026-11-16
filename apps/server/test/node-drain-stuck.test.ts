import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QUIET_ALARM_MS } from '@hornhoof/protocol';
import { TOOL_QUIET_ALARM_MS } from '@hornhoof/protocol/map';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agentEvents, agents, companies, departments, jobs, machines, nodes, people, subscriptions, tasks } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { TURN_TIMEOUT_MS } from '../src/modules/conversation/queue.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const BUILTIN_KEY = 'builtin-stuck-drain-key-0123456789abcdef';
const MINUTE_MS = 60_000;

async function stuckStand(env: NodeJS.ProcessEnv = {}) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-13T16:55:00.000Z'));
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp({ NODE_KEY: BUILTIN_KEY, HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-stuck-drain-')), ...env });
  await setUpCompany(app);
  const url = await listen(app);
  const [company] = await db.select().from(companies);
  const [person] = await db.select(idOnly(people)).from(people);
  const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
  const [machine] = await db.insert(machines).values({ companyId: company!.id, personId: person!.id, machineKey: 'laptop-host-key', hostname: 'laptop' }).returning();
  const [sub] = await db.insert(subscriptions).values({ companyId: company!.id, provider: 'kimi', kind: 'personal', label: 'Kimi', ownerPersonId: person!.id, status: 'ready' }).returning();
  const nodeKey = 'personal-stuck-node-key-0123456789abcdef';
  const [nodeRow] = await db.insert(nodes).values({ companyId: company!.id, machineId: machine!.id, subscriptionId: sub!.id, keyHash: hashToken(nodeKey), status: 'ready', version: '0.18.17' }).returning();
  const [worker] = await db.insert(agents).values({ companyId: company!.id, departmentId: dept!.id, subscriptionId: sub!.id, nodeId: nodeRow!.id, kind: 'worker', model: '', roleKey: 'DEV-BE', name: 'Worker' }).returning();
  const askNode = () => app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${nodeKey}` }, payload: {} });
  const askBuiltin = () => app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${BUILTIN_KEY}` }, payload: {} });
  return { app, db, url, company: company!, sub: sub!, nodeId: nodeRow!.id, nodeKey, worker: worker!, askNode, askBuiltin };
}

describe('node drain updates silent or stuck nodes without interrupting live work', () => {
  it('permits the update immediately when an open node socket sends no node signs past the node silence threshold', async () => {
    const s = await stuckStand();
    const startAt = new Date(Date.now());
    const [running] = await s.db.insert(jobs).values({
      companyId: s.company.id,
      subscriptionId: s.sub.id,
      agentId: s.worker.id,
      nodeId: s.nodeId,
      kind: 'conversation',
      prompt: 'Work on task',
      status: 'running',
      createdAt: startAt,
      startedAt: startAt,
      timeoutMs: TURN_TIMEOUT_MS,
    }).returning();

    const sock = await connectNode(s.url, s.nodeKey);
    onTestFinished(() => sock.close());
    sock.send({ type: 'hello', version: '0.18.17', loggedIn: true, running: [running!.id] });
    await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));

    /* 11 minutes pass with no load or job.program frames while the TCP/WebSocket stays open; reconcile still leaves the turn running. */
    vi.setSystemTime(Date.now() + QUIET_ALARM_MS + MINUTE_MS);
    await reconcile(s.app.ctx, new Date());

    const res = await s.askNode();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  it('permits the update immediately when a disconnected node stays silent past the threshold with running work', async () => {
    const s = await stuckStand();
    const startAt = new Date(Date.now());
    const [running] = await s.db.insert(jobs).values({
      companyId: s.company.id,
      subscriptionId: s.sub.id,
      nodeId: s.nodeId,
      kind: 'test',
      prompt: 'npm test',
      status: 'running',
      createdAt: startAt,
      startedAt: startAt,
      timeoutMs: TURN_TIMEOUT_MS,
    }).returning();

    const sock = await connectNode(s.url, s.nodeKey);
    sock.send({ type: 'hello', version: '0.18.17', loggedIn: true, running: [running!.id] });
    await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));
    sock.close();
    await until(() => !s.app.ctx.hub.isOnline({ kind: 'node', nodeId: s.nodeId }));

    vi.setSystemTime(Date.now() + QUIET_ALARM_MS + MINUTE_MS);
    await reconcile(s.app.ctx, new Date());

    const res = await s.askNode();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  it('permits the update when an online node keeps sending load and stale job.program reports without taking any work for a full drain cycle', async () => {
    const s = await stuckStand();
    const sock = await connectNode(s.url, s.nodeKey);
    onTestFinished(() => sock.close());
    const stuckStart = Date.now() - 12 * 60 * MINUTE_MS;
    const [stuck] = await s.db.insert(jobs).values({
      companyId: s.company.id,
      subscriptionId: s.sub.id,
      agentId: s.worker.id,
      nodeId: s.nodeId,
      kind: 'conversation',
      prompt: 'Old stuck turn',
      status: 'running',
      createdAt: new Date(stuckStart),
      startedAt: new Date(stuckStart),
      timeoutMs: TURN_TIMEOUT_MS,
    }).returning();
    await s.db.insert(jobs).values({
      companyId: s.company.id,
      subscriptionId: s.sub.id,
      agentId: s.worker.id,
      kind: 'conversation',
      prompt: 'Waiting turn in queue',
      status: 'queued',
      timeoutMs: TURN_TIMEOUT_MS,
    });

    sock.send({ type: 'hello', version: '0.18.17', loggedIn: true, running: [stuck!.id] });
    await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));
    /* The node socket stays alive, reporting current load and repeating job.program with its frozen signAt from 12 hours ago. */
    const now = new Date();
    const identity = { kind: 'node' as const, nodeId: s.nodeId };
    await handleNodeMessage(s.app.ctx, identity, { type: 'load', cpus: 8, load: 0.2, memTotal: 16e9, memFree: 12e9, tests: 0, jobs: 1 }, now);
    await handleNodeMessage(s.app.ctx, identity, { type: 'job.program', jobId: stuck!.id, state: 'thinking', since: stuckStart, screenAt: stuckStart, signAt: stuckStart }, now);

    const res = await s.askNode();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  it('also updates an online node stuck in endless retrying when no work was taken for a full drain cycle, while keeping genuinely live long work intact', async () => {
    const s = await stuckStand();
    const sock = await connectNode(s.url, s.nodeKey);
    onTestFinished(() => sock.close());
    const longAgo = Date.now() - 4 * 60 * MINUTE_MS;
    const [turn] = await s.db.insert(jobs).values({
      companyId: s.company.id,
      subscriptionId: s.sub.id,
      agentId: s.worker.id,
      nodeId: s.nodeId,
      kind: 'conversation',
      prompt: 'Long running work',
      status: 'running',
      createdAt: new Date(longAgo),
      startedAt: new Date(longAgo),
      timeoutMs: TURN_TIMEOUT_MS,
    }).returning();

    sock.send({ type: 'hello', version: '0.23.3', loggedIn: true, running: [turn!.id] });
    await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));
    const nowMs = Date.now();
    const identity = { kind: 'node' as const, nodeId: s.nodeId };

    /* While the turn's program is genuinely active (fresh signAt on a running tool), even a 4-hour turn is NOT interrupted. */
    await handleNodeMessage(s.app.ctx, identity, {
      type: 'job.program',
      jobId: turn!.id,
      state: 'tool',
      tool: 'Bash',
      since: nowMs - 2 * MINUTE_MS,
      screenAt: nowMs - MINUTE_MS,
      signAt: nowMs - MINUTE_MS,
    }, new Date(nowMs));
    expect((await s.askNode()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });
    expect((await s.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, turn!.id)))[0]!.status).toBe('running');

    /* Once the same old turn has been stuck in continuous retrying since 4 hours ago, the drain stops waiting forever. */
    await handleNodeMessage(s.app.ctx, identity, {
      type: 'job.program',
      jobId: turn!.id,
      state: 'retrying',
      since: longAgo,
      screenAt: nowMs - MINUTE_MS,
      signAt: nowMs - MINUTE_MS,
      retry: { attempt: 99, max: null, nextAt: nowMs + MINUTE_MS },
    }, new Date(nowMs));
    expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  it('updates a node whose old turns hang although another agent there took and ended a turn within the cycle', async () => {
    const s = await stuckStand();
    const sock = await connectNode(s.url, s.nodeKey);
    onTestFinished(() => sock.close());
    const [other] = await s.db.insert(agents).values({ companyId: s.company.id, departmentId: s.worker.departmentId, subscriptionId: s.sub.id, nodeId: s.nodeId, kind: 'worker', model: '', roleKey: 'DEV-FE', name: 'Other' }).returning();
    /* The turn the node lost two days ago: Hornhoof still counts it as running, and nothing of it comes any more. */
    const lostAt = new Date(Date.now() - 48 * 60 * MINUTE_MS);
    const [lost] = await s.db.insert(jobs).values({ companyId: s.company.id, subscriptionId: s.sub.id, agentId: s.worker.id, nodeId: s.nodeId, kind: 'conversation', prompt: 'Lost turn', status: 'running', createdAt: lostAt, startedAt: lostAt, timeoutMs: TURN_TIMEOUT_MS }).returning();
    /* While the update waited, another agent there had a turn of its own, which ended a quarter of an hour ago. */
    const tookAt = new Date(Date.now() - 20 * MINUTE_MS);
    await s.db.insert(jobs).values({ companyId: s.company.id, subscriptionId: s.sub.id, agentId: other!.id, nodeId: s.nodeId, kind: 'conversation', prompt: 'Short turn', status: 'done', createdAt: tookAt, startedAt: tookAt, finishedAt: new Date(Date.now() - 15 * MINUTE_MS), timeoutMs: TURN_TIMEOUT_MS });

    sock.send({ type: 'hello', version: '0.18.17', loggedIn: true, running: [lost!.id] });
    await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));
    await handleNodeMessage(s.app.ctx, { kind: 'node', nodeId: s.nodeId }, { type: 'load', cpus: 8, load: 0.2, memTotal: 16e9, memFree: 12e9, tests: 0, jobs: 1 }, new Date());

    expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  it('updates a node of a build from before load and program reports, whose socket comes back every few minutes, once its turn has hung', async () => {
    const s = await stuckStand();
    const startAt = new Date(Date.now() - 3 * 60 * MINUTE_MS);
    const [hung] = await s.db.insert(jobs).values({ companyId: s.company.id, subscriptionId: s.sub.id, agentId: s.worker.id, nodeId: s.nodeId, kind: 'conversation', prompt: 'Hung turn', status: 'running', createdAt: startAt, startedAt: startAt, timeoutMs: TURN_TIMEOUT_MS }).returning();
    /* A node that sends no load is cut after a few quiet minutes and comes back with a new hello: its socket is fresh, its
       turn says nothing. */
    const sock = await connectNode(s.url, s.nodeKey);
    onTestFinished(() => sock.close());
    sock.send({ type: 'hello', version: '0.16.4', loggedIn: true, running: [hung!.id] });
    await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));

    expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  describe('waits for a turn that is still live by its own signs, and only while it is', () => {
    /* A node that answers, with one turn it took four hours ago: past a full drain-and-retry cycle, so the turn's own signs
       decide. */
    async function liveStand(turn: { startedAgoMs?: number; restartedAgoMs?: number; task?: (s: Awaited<ReturnType<typeof stuckStand>>) => Promise<string> } = {}) {
      const s = await stuckStand();
      const sock = await connectNode(s.url, s.nodeKey);
      onTestFinished(() => sock.close());
      const startedAt = new Date(Date.now() - (turn.startedAgoMs ?? 4 * 60 * MINUTE_MS));
      const restartedAt = turn.restartedAgoMs === undefined ? null : new Date(Date.now() - turn.restartedAgoMs);
      const taskId = turn.task ? await turn.task(s) : undefined;
      const [job] = await s.db.insert(jobs).values({ companyId: s.company.id, subscriptionId: s.sub.id, agentId: s.worker.id, nodeId: s.nodeId, taskId, kind: 'conversation', prompt: 'Long turn', status: 'running', createdAt: startedAt, startedAt, restartedAt, timeoutMs: TURN_TIMEOUT_MS }).returning();
      sock.send({ type: 'hello', version: '0.23.3', loggedIn: true, running: [job!.id] });
      await until(() => s.app.ctx.hub.isReady({ kind: 'node', nodeId: s.nodeId }));
      const identity = { kind: 'node' as const, nodeId: s.nodeId };
      /* The node itself goes on answering at every moment the test looks. */
      const answers = () => handleNodeMessage(s.app.ctx, identity, { type: 'load', cpus: 8, load: 0.2, memTotal: 16e9, memFree: 12e9, tests: 0, jobs: 1 }, new Date());
      await answers();
      return { ...s, job: job!, startedAt, identity, answers };
    }

    it('while the turn took a step within the quiet limit although its program reports nothing new', async () => {
      const s = await liveStand();
      const at = Date.now();
      const old = s.startedAt.getTime();
      await handleNodeMessage(s.app.ctx, s.identity, { type: 'job.program', jobId: s.job.id, state: 'thinking', since: old, screenAt: old, signAt: old }, new Date(at));
      await s.db.insert(agentEvents).values({ companyId: s.company.id, agentId: s.worker.id, jobId: s.job.id, kind: 'tool', data: { name: 'Bash' }, createdAt: new Date(at - MINUTE_MS) });
      expect((await s.askNode()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });

      vi.setSystemTime(at + QUIET_ALARM_MS);
      await s.answers();
      expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    });

    it('while the task of the turn waits for an outside event', async () => {
      const waits = async (stand: Awaited<ReturnType<typeof stuckStand>>) => {
        const now = Date.now();
        const externalWait = { reason: 'A test run', since: new Date(now - 60 * MINUTE_MS).toISOString(), until: new Date(now + 30 * MINUTE_MS).toISOString() };
        const [task] = await stand.db.insert(tasks).values({ companyId: stand.company.id, number: 1, title: 'Waits for a run', status: 'working', assigneeAgentId: stand.worker.id, externalWait }).returning();
        return task!.id;
      };
      const s = await liveStand({ task: waits });
      const at = Date.now();
      expect((await s.askNode()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });

      vi.setSystemTime(at + 31 * MINUTE_MS);
      await s.answers();
      expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    });

    it('while its program runs one tool, quiet for longer than a turn may be but not than a tool may', async () => {
      const s = await liveStand();
      const at = Date.now();
      const toolAt = at - 2 * QUIET_ALARM_MS;
      await handleNodeMessage(s.app.ctx, s.identity, { type: 'job.program', jobId: s.job.id, state: 'tool', tool: 'Bash', since: toolAt, screenAt: toolAt, signAt: toolAt }, new Date(at));
      expect((await s.askNode()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });

      vi.setSystemTime(toolAt + TOOL_QUIET_ALARM_MS);
      await s.answers();
      expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    });

    it('while its program asks a question within the time of the turn', async () => {
      const s = await liveStand({ startedAgoMs: TURN_TIMEOUT_MS - 10 * MINUTE_MS });
      const at = Date.now();
      const old = s.startedAt.getTime();
      await handleNodeMessage(s.app.ctx, s.identity, { type: 'job.program', jobId: s.job.id, state: 'asking', since: old, screenAt: old, signAt: old }, new Date(at));
      expect((await s.askNode()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });

      vi.setSystemTime(at + 11 * MINUTE_MS);
      await s.answers();
      expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    });

    it('while a restarted turn asks a question within the turn timeout measured from its restart', async () => {
      const s = await liveStand({ startedAgoMs: 4 * 60 * MINUTE_MS, restartedAgoMs: TURN_TIMEOUT_MS - 10 * MINUTE_MS });
      const at = Date.now();
      const restarted = s.job.restartedAt!.getTime();
      await handleNodeMessage(s.app.ctx, s.identity, { type: 'job.program', jobId: s.job.id, state: 'asking', since: restarted, screenAt: restarted, signAt: restarted }, new Date(at));
      expect((await s.askNode()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });

      vi.setSystemTime(at + 11 * MINUTE_MS);
      await s.answers();
      expect((await s.askNode()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    });
  });
});
