import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, departments, jobs, nodes, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { handleNodeMessage } from '../src/modules/nodes/messages.js';
import { NODE_STALE_MS, expireStaleNodes } from '../src/modules/nodes/nodes.js';
import { reconcile } from '../src/modules/tasks/reconcile.js';
import { agentProgramState } from '../src/modules/tasks/silent.js';
import { as, connectNode, listen, openStream, setUpCompany, testApp, until } from './helpers.js';
import { createHmac } from 'node:crypto';
import { builtinOf } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';

/* No round of pings comes during a test unless it says so: the longest wait a timer takes. */
async function liveCompany(pingMs = '2147483647') {
  const { app, db } = await testApp({ NODE_PING_MS: pingMs });
  const url = await listen(app);
  onTestFinished(() => app.close());
  const ceo = await setUpCompany(app);
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const joined = await app.inject({
    method: 'POST',
    url: '/api/nodes/join',
    payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' },
  });
  const { machine, nodes } = joined.json();
  return { app, db, url, ceo, machineId: machine.id as string, subId: nodes[0].subscriptionId as string, nodeId: nodes[0].nodeId as string, key: nodes[0].key as string };
}

const subOf = async (app: FastifyInstance, ceo: string, id: string) =>
  (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.find((s: { id: string }) => s.id === id);

const hello = (running: string[] = [], loggedIn = true) => ({ type: 'hello' as const, version: '0.2.0', loggedIn, running });

describe('node socket', () => {
  it('refuses a wrong key', async () => {
    const { url } = await liveCompany();
    await expect(connectNode(url, 'not-a-key')).rejects.toThrow(/401/);
  });

  it('names a built-in node by its machine, and one with the bare key of a node from before as its own', async () => {
    const NODE_KEY = 'k'.repeat(40);
    const { app } = await testApp({ NODE_KEY, NODE_PING_MS: '2147483647' });
    const url = await listen(app);
    const machine = 'a1b2c3d4'.repeat(4);
    const signed = (id: string, key = NODE_KEY) => createHmac('sha256', key).update(`hornhoof builtin node ${id}`).digest('hex');
    const online = () => [app.ctx.hub.isOnline(builtinOf(machine)), app.ctx.hub.isOnline(BUILTIN)];

    /* Each machine's built-in node signs in with a key made for its machine, and is that machine's. */
    const byMachine = await connectNode(url, `builtin.${machine}.${signed(machine)}`);
    expect(online()).toEqual([true, false]);
    /* A node of a build before sends the key bare: it is the one of the machine this server runs on. */
    const bare = await connectNode(url, NODE_KEY);
    expect(online()).toEqual([true, true]);
    byMachine.close();
    await byMachine.closed;
    expect(online()).toEqual([false, true]);
    bare.close();

    const other = 'f'.repeat(32);
    const flipped = signed(machine).replace(/^./, first => (first === '0' ? '1' : '0'));
    for (const key of [`builtin.${machine}.${flipped}`, `builtin.${other}.${signed(machine)}`, `builtin.${machine}.${signed(machine, 'another-key')}`, `builtin.short.${signed('short')}`])
      await expect(connectNode(url, key), key).rejects.toThrow(/401/);
  });

  it('follows the login state and shows the node online while connected', async () => {
    const { app, db, url, ceo, subId, nodeId, key } = await liveCompany();
    const node = await connectNode(url, key);
    node.send(hello([], false));
    await until(async () => (await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.version === '0.2.0');
    expect(await subOf(app, ceo, subId)).toMatchObject({ status: 'needs_login', online: true });
    const limits = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.4, resetsAt: null }] };
    node.send({ type: 'status', loggedIn: true, limits });
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    expect((await subOf(app, ceo, subId)).limits).toEqual(limits);
    /* A node that started again does not know the limits until its program says; the last ones stay. */
    node.send({ type: 'status', loggedIn: false, limits: null });
    await until(async () => (await subOf(app, ceo, subId)).status === 'needs_login');
    expect((await subOf(app, ceo, subId)).limits).toEqual(limits);
    node.send({ type: 'status', loggedIn: true, limits });
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    const machines = (await app.inject({ url: '/api/machines', ...as(ceo) })).json().machines;
    expect(machines[0].online).toBe(true);
    node.close();
    await node.closed;
    await until(async () => (await subOf(app, ceo, subId)).online === false);
  });

  it('timestamps every limits snapshot and replaces an old rejection with fresh data', async () => {
    const { app, db, ceo, subId, nodeId } = await liveCompany();
    const identity = { kind: 'node' as const, nodeId };
    const old = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-03T00:53:03.947Z' }] };
    const freshAt = new Date().toISOString();
    const fresh = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: new Date(Date.now() + 4 * 3600_000).toISOString() }], complete: true };

    await handleNodeMessage(app.ctx, identity, { type: 'status', loggedIn: true, limits: old }, new Date('2026-11-03T00:40:00.000Z'));
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]).toMatchObject({ limits: old, limitsUpdatedAt: new Date('2026-11-03T00:40:00.000Z') });
    expect(await subOf(app, ceo, subId)).toMatchObject({ limits: { status: 'allowed', windows: [], complete: false }, limitsUpdatedAt: '2026-11-03T00:40:00.000Z' });

    await handleNodeMessage(app.ctx, identity, { type: 'status', loggedIn: true, limits: fresh }, new Date(freshAt));
    expect(await subOf(app, ceo, subId)).toMatchObject({ limits: fresh, limitsUpdatedAt: freshAt });
  });

  it('keeps the limits and when they were read through a status with no reading in it, so they go stale when readings stop', async () => {
    const { app, db, subId, nodeId } = await liveCompany();
    const identity = { kind: 'node' as const, nodeId };
    const reading = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }], complete: true };
    const readAt = new Date('2026-11-03T00:40:00.000Z');
    await handleNodeMessage(app.ctx, identity, { type: 'status', loggedIn: true, limits: reading }, readAt);
    await handleNodeMessage(app.ctx, identity, { type: 'status', loggedIn: true, limits: null, models: [{ id: 'opus', name: 'Opus' }] }, new Date('2026-11-03T01:40:00.000Z'));
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]).toMatchObject({ limits: reading, limitsUpdatedAt: readAt, models: [{ id: 'opus', name: 'Opus' }] });
  });

  it("leaves a plan's hold to that plan's own readings: the same numbers from another plan say nothing of it", async () => {
    const { app, db, ceo, nodeId } = await liveCompany();
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(ceo) });
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: connected.json().command.split('--join ')[1], machineId: 'mac-0002-abcd', hostname: 'other-mac', os: 'darwin', arch: 'arm64' } });
    const other = joined.json().nodes[0] as { nodeId: string; subscriptionId: string };
    const reading = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }], complete: true };
    const at = new Date();
    const hold = { status: 'rejected' as const, windows: [{ name: 'five_hour', utilization: 1, resetsAt: new Date(at.getTime() + 3_600_000).toISOString() }] };
    await handleNodeMessage(app.ctx, { kind: 'node', nodeId }, { type: 'status', loggedIn: true, limits: reading }, at);
    await db.update(subscriptions).set({ limits: hold, limitsUpdatedAt: at }).where(eq(subscriptions.id, other.subscriptionId));
    await handleNodeMessage(app.ctx, { kind: 'node', nodeId: other.nodeId }, { type: 'status', loggedIn: true, limits: reading }, at);
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, other.subscriptionId)))[0]!.limits).toEqual(reading);
  });

  it('keeps the models a node reports, and keeps them when a message has none', async () => {
    const { db, url, subId, key } = await liveCompany();
    const node = await connectNode(url, key);
    const models = [{ id: 'opus', name: 'Opus' }, { id: 'sonnet', name: 'Sonnet' }];
    node.send({ ...hello(), models });
    const stored = async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!;
    await until(async () => (await stored()).models !== null);
    expect((await stored()).models).toEqual(models);
    node.send({ type: 'status', loggedIn: true, limits: null, models: [models[0]!] });
    await until(async () => (await stored()).models?.length === 1);
    node.send({ type: 'status', loggedIn: false, limits: null });
    await until(async () => (await stored()).status === 'needs_login');
    expect((await stored()).models).toEqual([models[0]]);
  });

  it("keeps how full each of its agents' context is and tells the map, for its own agents only", async () => {
    const { app, db, url, ceo, subId, nodeId, key } = await liveCompany();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [dept] = await db.insert(departments).values({ companyId: orchestrator!.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator!.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dept!.id, model: '', subscriptionId: subId, nodeId })
      .returning();
    const stream = await openStream(app, ceo);
    const node = await connectNode(url, key);
    node.send(hello());
    node.send({ type: 'agent.context', agentKey: orchestrator!.id, used: 0.9 });
    node.send({ type: 'agent.context', agentKey: '00000000-0000-4000-8000-000000000000', used: 0.9 });
    node.send({ type: 'agent.context', agentKey: bruno!.id, used: 0.42 });
    /* The socket's messages are handled one after the other and the stream keeps their order: any of the first two would come
       before Bruno's. */
    await until(() => stream.messages.some(m => m.type === 'context'));
    expect(stream.messages.filter(m => m.type === 'context')).toEqual([{ type: 'context', agentId: bruno!.id, used: 0.42 }]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees[0]).toMatchObject({ name: 'Bruno', context: 0.42 });
    expect(org.orchestrator.context).toBeNull();
  });

  it('drops a node that stops answering pings', async () => {
    /* The pings go by a clock the test moves; nothing else of the server runs on intervals this short. */
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const { app, url, ceo, subId, key } = await liveCompany('50');
    const node = await connectNode(url, key, { autoPong: false });
    /* Three pings go unanswered, and the round after them drops the node. */
    await vi.advanceTimersByTimeAsync(4 * 50);
    await node.closed;
    expect((await subOf(app, ceo, subId)).online).toBe(false);
  });

  it('closes the older socket when the same node connects again', async () => {
    const { app, url, ceo, subId, key } = await liveCompany();
    const first = await connectNode(url, key);
    const second = await connectNode(url, key);
    await first.closed;
    expect((await subOf(app, ceo, subId)).online).toBe(true);
    second.close();
  });

  it('fails jobs the node no longer knows after a restart', async () => {
    const { db, url, subId, nodeId, key } = await liveCompany();
    const [company] = await db.select(only(subscriptions, 'companyId')).from(subscriptions).where(eq(subscriptions.id, subId));
    const [job] = await db.insert(jobs).values({ companyId: company!.companyId, subscriptionId: subId, nodeId, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.status === 'failed');
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ error: 'machine_restarted' });
    node.close();
  });

  it('confirms each finished job it hears of, again when the node sends it again, and takes only the first', async () => {
    const { db, url, subId, nodeId, key } = await liveCompany();
    const [company] = await db.select(only(subscriptions, 'companyId')).from(subscriptions).where(eq(subscriptions.id, subId));
    const [job] = await db.insert(jobs).values({ companyId: company!.companyId, subscriptionId: subId, nodeId, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    const node = await connectNode(url, key);
    node.send(hello([job!.id]));
    const done = { type: 'job.done' as const, jobId: job!.id, ok: true, sessionId: 's', tail: '', error: null };
    node.send({ ...done, result: 'first' });
    await until(() => node.acks.length === 1);
    node.send({ ...done, result: 'again' });
    await until(() => node.acks.length === 2);
    expect(node.acks).toEqual([job!.id, job!.id]);
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ status: 'done', result: 'first' });
    node.close();
  });

  it("lets a node touch only its own subscription's jobs", async () => {
    const { app, db, url, ceo, subId, key } = await liveCompany();
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'pc-0002-abcd', hostname: 'maria-pc', os: 'linux', arch: 'x86_64' } });
    const other = joined.json().nodes[0];
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [theirs] = await db
      .insert(jobs)
      .values({ companyId: orchestrator!.companyId, subscriptionId: other.subscriptionId, agentId: orchestrator!.id, kind: 'conversation', prompt: 'x', status: 'running', timeoutMs: 900000, startedAt: new Date() })
      .returning();
    const node = await connectNode(url, key);
    node.send(hello([theirs!.id]));
    node.send({ type: 'job.event', jobId: theirs!.id, seq: 0, event: { kind: 'text', text: 'I finished it for them.' } });
    node.send({ type: 'job.done', jobId: theirs!.id, ok: true, sessionId: 's', result: 'Done by another machine.', tail: '', error: null });
    await until(() => node.acks.length === 1);
    expect((await db.select().from(jobs).where(eq(jobs.id, theirs!.id)))[0]).toMatchObject({ status: 'running', result: null });
    expect(await db.select().from(agentEvents).where(eq(agentEvents.jobId, theirs!.id))).toEqual([]);
    expect(subId).not.toBe(other.subscriptionId);
    node.close();
  });

  it('closes the socket with 4001 when the machine is disconnected in Hornhoof', async () => {
    const { app, db, url, ceo, machineId, subId, nodeId, key } = await liveCompany();
    const [company] = await db.select(only(subscriptions, 'companyId')).from(subscriptions).where(eq(subscriptions.id, subId));
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    const [job] = await db.insert(jobs).values({ companyId: company!.companyId, subscriptionId: subId, nodeId, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) });
    expect(await node.closed).toBe(4001);
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ status: 'failed', error: 'machine_disconnected' });
    await expect(connectNode(url, key)).rejects.toThrow(/401/);
  });

  it("sends no agent's next turn to a machine while it is being disconnected", async () => {
    const { app, db, url, ceo, machineId, subId, nodeId, key } = await liveCompany();
    const [company] = await db.select(only(subscriptions, 'companyId')).from(subscriptions).where(eq(subscriptions.id, subId));
    const companyId = company!.companyId;
    const [dept] = await db.insert(departments).values({ companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [bruno] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dept!.id, model: '', subscriptionId: subId, nodeId }).returning();
    const node = await connectNode(url, key);
    node.send({ ...hello([]), version: '0.5.0' });
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    const turn = { companyId, subscriptionId: subId, nodeId, agentId: bruno!.id, kind: 'conversation' as const, timeoutMs: 900000 };
    await db.insert(jobs).values({ ...turn, prompt: 'first', status: 'running', startedAt: new Date() });
    const [next] = await db.insert(jobs).values({ ...turn, prompt: 'second', status: 'queued' }).returning();
    await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) });
    expect(await node.closed).toBe(4001);
    expect(node.queued()).toBe(0);
    expect((await db.select().from(jobs).where(eq(jobs.id, next!.id)))[0]).toMatchObject({ status: 'queued', startedAt: null });
  });

  it('lets a status that comes in after the disconnect leave the subscription waiting for a machine', async () => {
    const { app, db, url, ceo, machineId, subId, nodeId, key } = await liveCompany();
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) });
    await node.closed;
    const late = { kind: 'node' as const, nodeId };
    await handleNodeMessage(app.ctx, late, { type: 'status', loggedIn: true, limits: null });
    await handleNodeMessage(app.ctx, late, hello([]));
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]).toMatchObject({ status: 'waiting_machine' });
    expect((await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]).toMatchObject({ keyHash: null });
    const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
    const code = connected.json().command.split('--join ')[1];
    const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } });
    expect(joined.statusCode).toBe(200);
  });

  it('tells an online node to clean up when its subscription is removed', async () => {
    const { app, db, url, ceo, subId, nodeId, key } = await liveCompany();
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).online === true);
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subId}`, ...as(ceo) })).statusCode).toBe(204);
    expect(await node.next()).toEqual({ type: 'remove' });
    node.send({ type: 'removed' });
    await node.closed;
    await until(async () => (await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.keyHash === null);
    expect((await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status).toBe('needs_login');
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.leaseNodeId).toBeNull();
  });

  it('tells a removed subscription to clean up as soon as it says hello', async () => {
    const { app, url, ceo, subId, key } = await liveCompany();
    await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subId}`, ...as(ceo) });
    const node = await connectNode(url, key);
    node.send(hello([]));
    expect(await node.next()).toEqual({ type: 'remove' });
    node.close();
  });

  it('marks a node silent for more than 24 hours as not ready and restores readiness after hello', async () => {
    const { app, db, url, ceo, subId, nodeId, key } = await liveCompany();
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    node.close();
    await node.closed;

    const now = new Date();
    const justUnder24h = new Date(now.getTime() - NODE_STALE_MS + 60_000);
    await db.update(nodes).set({ lastSeenAt: justUnder24h }).where(eq(nodes.id, nodeId));
    await expireStaleNodes(db, now);
    expect((await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status).toBe('ready');

    const [orchestrator] = await db.select().from(agents);
    const turnStartedAt = new Date(now.getTime() - 40 * 60_000);
    const [turn] = await db
      .insert(jobs)
      .values({
        companyId: orchestrator!.companyId,
        subscriptionId: subId,
        nodeId,
        agentId: orchestrator!.id,
        kind: 'conversation',
        prompt: 'Check status.',
        timeoutMs: 900_000,
        status: 'running',
        startedAt: turnStartedAt,
      })
      .returning();

    const silentSince = new Date(now.getTime() - NODE_STALE_MS);
    await db.update(nodes).set({ lastSeenAt: silentSince }).where(eq(nodes.id, nodeId));
    await reconcile(app.ctx, now);
    expect(agentProgramState(app.ctx, turn).alarm).toBeNull();

    await db.update(nodes).set({ status: 'ready', lastSeenAt: silentSince }).where(eq(nodes.id, nodeId));
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, subId));
    await expireStaleNodes(db, now);
    const machinesRes = (await app.inject({ url: '/api/machines', ...as(ceo) })).json();
    expect(machinesRes.machines[0].plans[0].status).toBe('needs_login');

    await db.update(nodes).set({ status: 'ready', lastSeenAt: silentSince }).where(eq(nodes.id, nodeId));
    await db.update(subscriptions).set({ status: 'ready' }).where(eq(subscriptions.id, subId));
    await expireStaleNodes(db, now);
    const staleSub = await subOf(app, ceo, subId);
    expect(staleSub.status).toBe('needs_login');
    expect(staleSub.machines[0].status).toBe('needs_login');
    expect((await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status).toBe('needs_login');
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.status).toBe('needs_login');

    const back = await connectNode(url, key);
    back.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    expect((await subOf(app, ceo, subId)).machines[0].status).toBe('ready');
    expect((await db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status).toBe('ready');
    back.close();
  });
});
