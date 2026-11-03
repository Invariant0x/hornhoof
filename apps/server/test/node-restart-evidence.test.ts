import type { NodeMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, nodes, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const firstBoot = { startedAt: '2026-11-03T20:00:00.000Z', machineUpAt: '2026-11-01T00:00:00.000Z', container: 'old-container' };
const nextBoot = { ...firstBoot, startedAt: '2026-11-03T21:00:00.000Z', container: 'new-container' };
const planned = { kind: 'planned' as const, reason: 'node_update' as const, startedAt: firstBoot.startedAt, at: '2026-11-03T20:59:59.000Z', log: 'Stopping node: node_update.' };
type Hello = Extract<NodeMessage, { type: 'hello' }>;

async function personalNode() {
  const { app, db } = await testApp({ NODE_KEY: 'k'.repeat(40), HORNHOOF_HOST_ID: hashToken('hornhoof-host:a-host-machine') });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'a-host-machine', hostname: 'a-host', os: 'linux', arch: 'x86_64' } });
  expect(joined.statusCode, joined.body).toBe(200);
  const identity = joined.json().nodes[0] as { nodeId: string; key: string; subscriptionId: string };
  let socket = await connectNode(url, identity.key);
  const row = async () => (await db.select().from(nodes).where(eq(nodes.id, identity.nodeId)))[0]!;
  socket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], boot: firstBoot, restart: { kind: 'unknown', reason: 'unknown', startedAt: null, at: null, log: '' }, nodeLog: 'Node started.' });
  await until(async () => (await row()).status === 'ready');
  const [job] = await db.insert(jobs).values({ companyId: (await row()).companyId, subscriptionId: identity.subscriptionId, nodeId: identity.nodeId, kind: 'test', prompt: 'Check.', timeoutMs: 60_000, status: 'running', startedAt: new Date('2026-11-03T20:30:00.000Z') }).returning();
  const failed = async () => (await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!;
  const restart = async (extra: Partial<Hello> = {}) => {
    socket.close();
    await socket.closed;
    socket = await connectNode(url, identity.key);
    socket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], boot: nextBoot, ...extra });
    await until(async () => (await failed()).status === 'failed');
    return failed();
  };
  const stopping = async (startedAt: string, exit = planned) => {
    await db.update(nodes).set({ status: 'ready' }).where(eq(nodes.id, identity.nodeId));
    socket.send({ type: 'node.stopping', startedAt, exit });
    socket.send({ type: 'status', loggedIn: false, limits: null });
    await until(async () => (await row()).status === 'needs_login');
  };
  return { app, url, db, identity, row, failed, restart, stopping };
}

describe('node restart evidence stored with a failure', () => {
  it('keeps a graceful update and authenticated machine, even if the next hello omits the report', async () => {
    const c = await personalNode();
    await c.stopping(firstBoot.startedAt);
    expect((await c.row()).boot).toMatchObject({ ...firstBoot, stopped: planned });
    expect((await c.failed()).status).toBe('running');
    const cut = await c.restart();
    expect(cut).toMatchObject({ error: 'machine_restarted', tail: '', interruption: { cause: 'container', node: { id: c.identity.nodeId, name: 'a-host' }, machine: { id: (await c.row()).machineId, name: 'a-host' }, diagnosis: planned } });
  });

  it('keeps the killed process report and its previous node log', async () => {
    const c = await personalNode();
    const exit = { kind: 'unplanned' as const, reason: 'unclean_exit' as const, startedAt: firstBoot.startedAt, at: null, log: 'Node started.\nConnection opened.\nInstalling tools.' };
    expect((await c.restart({ restart: exit, nodeLog: 'New node started.' })).interruption).toMatchObject({ diagnosis: exit });
  });

  it('accepts an old hello with unknown diagnosis', async () => {
    const c = await personalNode();
    expect((await c.restart()).interruption).toMatchObject({ diagnosis: { kind: 'unknown', reason: 'unknown', log: '', startedAt: null, at: null } });
  });

  it('ignores a stop for a different generation and a mismatched previous exit', async () => {
    const c = await personalNode();
    await c.stopping('2026-11-03T19:00:00.000Z');
    expect((await c.row()).boot).not.toHaveProperty('stopped');
    expect((await c.restart({ restart: { ...planned, startedAt: '2026-11-03T19:00:00.000Z' } })).interruption).toMatchObject({ diagnosis: { kind: 'unknown', reason: 'unknown' } });
  });

  it('keeps the first completed stop on a duplicate, and clears it when the new generation greets', async () => {
    const c = await personalNode();
    await c.stopping(firstBoot.startedAt);
    await c.stopping(firstBoot.startedAt, { ...planned, log: 'A duplicate report.' });
    expect((await c.row()).boot).toMatchObject({ stopped: planned });
    await c.restart();
    expect((await c.row()).boot).toEqual(nextBoot);
  });

  it('does not replay an old planned exit when the same process loses a job', async () => {
    const c = await personalNode();
    const currentLog = 'Connection closed: 1006.\nConnection opened.';
    expect((await c.restart({ boot: firstBoot, restart: { ...planned, startedAt: '2026-11-03T19:00:00.000Z' }, nodeLog: currentLog })).interruption).toMatchObject({ cause: 'connection', diagnosis: { kind: 'unplanned', reason: 'disconnected', startedAt: firstBoot.startedAt, log: currentLog } });
  });

  it.each([
    { startedAt: '2026-11-03T20:30:00.000Z', reason: 'node_update' },
    { startedAt: '2026-11-03T21:30:00.000Z', reason: 'server_restart' },
  ])('identifies the built-in machine and attributes a first hello for a job at $startedAt', async ({ startedAt, reason }) => {
    const c = await personalNode();
    const [sub] = await c.db.select().from(subscriptions).where(eq(subscriptions.kind, 'api_key'));
    const [job] = await c.db.insert(jobs).values({ companyId: sub!.companyId, subscriptionId: sub!.id, kind: 'test', prompt: 'Check.', timeoutMs: 60_000, status: 'running', startedAt: new Date(startedAt) }).returning();
    const socket = await connectNode(c.url, 'k'.repeat(40));
    socket.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], boot: nextBoot, restart: planned, nodeLog: 'Current process reconnected.' });
    const failed = async () => (await c.db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]!;
    await until(async () => (await failed()).status === 'failed');
    expect((await failed()).interruption).toMatchObject({ machine: { id: (await c.row()).machineId, name: 'a-host' }, diagnosis: { kind: 'planned', reason, log: reason === 'server_restart' ? 'Current process reconnected.' : planned.log } });
  });
});
