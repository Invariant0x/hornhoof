import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished } from 'vitest';
import { jobs, subscriptions } from '../src/db/schema.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

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
    const machines = (await app.inject({ url: '/api/machines', ...as(ceo) })).json().machines;
    expect(machines[0].online).toBe(true);
    node.close();
    await node.closed;
    await until(async () => (await subOf(app, ceo, subId)).online === false);
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
