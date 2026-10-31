import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { agents, departments, jobs, subscriptions } from '../src/db/schema.js';
import { as, connectNode, listen, openStream, setUpCompany, testApp, until } from './helpers.js';

async function liveCompany() {
  const { app, db } = await testApp({ NODE_PING_MS: '50' });
  const url = await listen(app);
  onTestFinished(() => app.close());
  const ceo = await setUpCompany(app);
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const joined = await app.inject({
    method: 'POST',
    url: '/api/nodes/join',
    payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' },
  });
  const { machine, nodes } = joined.json();
  return { app, db, url, ceo, machineId: machine.id as string, subId: nodes[0].subscriptionId as string, key: nodes[0].key as string };
}

const subOf = async (app: FastifyInstance, ceo: string, id: string) =>
  (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.find((s: { id: string }) => s.id === id);

const hello = (running: string[] = [], loggedIn = true) => ({ type: 'hello' as const, version: '0.2.0', loggedIn, running });

describe('node socket', () => {
  it('refuses a wrong key', async () => {
    const { url } = await liveCompany();
    await expect(connectNode(url, 'not-a-key')).rejects.toThrow(/401/);
  });

  it('follows the login state and shows the node online while connected', async () => {
    const { app, db, url, ceo, subId, key } = await liveCompany();
    const node = await connectNode(url, key);
    node.send(hello([], false));
    await until(async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.nodeVersion === '0.2.0');
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

  it('keeps the commands a node reports missing without changing the subscription status', async () => {
    const { app, db, url, ceo, subId, key } = await liveCompany();
    const node = await connectNode(url, key);
    const missing = [{ provider: 'claude' as const, command: 'uptime' }];
    node.send({ ...hello(), missing });
    const stored = async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!;
    await until(async () => (await stored()).nodeVersion === '0.2.0');
    expect((await stored()).missing).toEqual(missing);
    expect(await subOf(app, ceo, subId)).toMatchObject({ status: 'ready', missing });
    node.send({ type: 'status', loggedIn: false, limits: null, missing: [] });
    await until(async () => (await stored()).status === 'needs_login');
    expect((await stored()).missing).toEqual([]);
    expect(await subOf(app, ceo, subId)).toMatchObject({ status: 'needs_login', missing: [] });
    node.close();
  });

  it("keeps how full each of its agents' context is and tells the map, for its own agents only", async () => {
    const { app, db, url, ceo, subId, key } = await liveCompany();
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [dept] = await db.insert(departments).values({ companyId: orchestrator!.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: orchestrator!.companyId, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dept!.id, model: '', subscriptionId: subId })
      .returning();
    const stream = await openStream(app, ceo);
    const node = await connectNode(url, key);
    node.send(hello());
    node.send({ type: 'agent.context', agentKey: orchestrator!.id, used: 0.9 });
    node.send({ type: 'agent.context', agentKey: '00000000-0000-4000-8000-000000000000', used: 0.9 });
    node.send({ type: 'agent.context', agentKey: bruno!.id, used: 0.42 });
    await until(() => stream.messages.some(m => m.type === 'context'));
    await new Promise(r => setTimeout(r, 200));
    expect(stream.messages.filter(m => m.type === 'context')).toEqual([{ type: 'context', agentId: bruno!.id, used: 0.42 }]);
    const org = (await app.inject({ url: '/api/org', ...as(ceo) })).json();
    expect(org.departments[0].employees[0]).toMatchObject({ name: 'Bruno', context: 0.42 });
    expect(org.orchestrator.context).toBeNull();
  });

  it('drops a node that stops answering pings', async () => {
    const { app, url, ceo, subId, key } = await liveCompany();
    const node = await connectNode(url, key, { autoPong: false });
    const started = Date.now();
    await node.closed;
    expect(Date.now() - started).toBeLessThan(300);
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
    const { db, url, subId, key } = await liveCompany();
    const [company] = await db.select({ companyId: subscriptions.companyId }).from(subscriptions).where(eq(subscriptions.id, subId));
    const [job] = await db.insert(jobs).values({ companyId: company!.companyId, subscriptionId: subId, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!.status === 'failed');
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ error: 'machine_restarted' });
    node.close();
  });

  it('closes the socket with 4001 when the machine is disconnected in Hornhoof', async () => {
    const { app, db, url, ceo, machineId, subId, key } = await liveCompany();
    const [company] = await db.select({ companyId: subscriptions.companyId }).from(subscriptions).where(eq(subscriptions.id, subId));
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).status === 'ready');
    const [job] = await db.insert(jobs).values({ companyId: company!.companyId, subscriptionId: subId, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) });
    expect(await node.closed).toBe(4001);
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ status: 'failed', error: 'machine_disconnected' });
    await expect(connectNode(url, key)).rejects.toThrow(/401/);
  });

  it('tells an online node to clean up when its subscription is removed', async () => {
    const { app, db, url, ceo, subId, key } = await liveCompany();
    const node = await connectNode(url, key);
    node.send(hello([]));
    await until(async () => (await subOf(app, ceo, subId)).online === true);
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subId}`, ...as(ceo) })).statusCode).toBe(204);
    expect(await node.next()).toEqual({ type: 'remove' });
    node.send({ type: 'removed' });
    await node.closed;
    await until(async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, subId)))[0]!.nodeKeyHash === null);
  });

  it('tells a removed subscription to clean up as soon as it says hello', async () => {
    const { app, url, ceo, subId, key } = await liveCompany();
    await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subId}`, ...as(ceo) });
    const node = await connectNode(url, key);
    node.send(hello([]));
    expect(await node.next()).toEqual({ type: 'remove' });
    node.close();
  });
});
