import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, machines, nodes, people, subscriptions } from '../src/db/schema.js';
import { nodeHeld } from '../src/modules/updates/drain.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'builtin-drain-key-0123456789abcdef';
const headers = { authorization: `Bearer ${NODE_KEY}` };

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const control = mkdtempSync(join(tmpdir(), 'hh-node-drain-'));
  const { app, db } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: control, ...env });
  const ceo = await setUpCompany(app);
  const [company] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [agent] = await db.select().from(agents);
  const [job] = await db.insert(jobs).values({ companyId: company!.id, subscriptionId: sub!.id, agentId: agent!.id, kind: 'conversation', prompt: 'Keep working', status: 'running', startedAt: new Date(), timeoutMs: 900_000 }).returning();
  const prepare = () => app.inject({ method: 'POST', url: '/api/nodes/update', headers, payload: {} });
  return { app, db, ceo, company: company!, agent: agent!, job: job!, control, prepare };
}

describe('planned node updates', () => {
  it('postpones all server-host nodes together when one still has work', async () => {
    const host = 'shared-update-host';
    const f = await fixture({ HORNHOOF_HOST_ID: hashToken(`hornhoof-host:${host}`), NODE_DRAIN_MS: '80', NODE_UPDATE_RETRY_MS: '1000' });
    const [owner] = await f.db.select().from(people);
    const [machine] = await f.db.insert(machines).values({ companyId: f.company.id, personId: owner!.id, machineKey: host, hostname: 'shared host' }).returning();
    const [node] = await f.db.insert(nodes).values({ companyId: f.company.id, machineId: machine!.id, keyHash: hashToken('personal-update-key') }).returning();
    await f.db.update(jobs).set({ nodeId: node!.id }).where(eq(jobs.id, f.job.id));
    const prepare = () => f.app.inject({ method: 'POST', url: '/api/nodes/update', headers, payload: { scope: 'server' } });
    const response = await prepare();
    expect(response.json().ready).toBe(false);
    expect((await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json().builtin.drain.state).toBe('waiting');
    await until(async () => (await prepare()).json().drain.state === 'postponed');
    expect(nodeHeld(f.app.ctx, { kind: 'builtin' })).toBe(false);
    expect(nodeHeld(f.app.ctx, { kind: 'node', nodeId: node!.id })).toBe(false);
    expect((await f.db.select().from(jobs).where(eq(jobs.id, f.job.id)))[0]).toMatchObject({ status: 'running', error: null });
  });

  it('keeps restart holds across the server restart until the node reports a new boot', async () => {
    const f = await fixture();
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, f.job.id));
    expect((await f.prepare()).json().ready).toBe(true);
    await f.app.close();
    const next = await buildApp({ db: f.db, config: f.app.ctx.config });
    onTestFinished(() => next.close());
    expect(nodeHeld(next.ctx, { kind: 'builtin' })).toBe(true);
    expect((await next.inject({ url: '/api/machines', ...as(f.ceo) })).json().builtin.drain.state).toBe('restarting');
  });

  it('waits for the last running turn without interrupting it, then permits the update', async () => {
    const f = await fixture();
    const waiting = await f.prepare();
    expect(waiting.statusCode).toBe(200);
    expect(waiting.json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1, partsLeft: 0, until: expect.any(String) } });
    expect((await f.db.select().from(jobs).where(eq(jobs.id, f.job.id)))[0]).toMatchObject({ status: 'running', error: null });
    const view = (await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json();
    expect(view.builtin.drain).toEqual(waiting.json().drain);
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, f.job.id));
    expect((await f.prepare()).json()).toMatchObject({ ready: true, drain: { state: 'restarting', since: expect.any(String) } });
    expect((await f.db.select().from(jobs).where(eq(jobs.id, f.job.id)))[0]!.error).toBeNull();
  });

  it('keeps a turn intact at the deadline, notifies Operations once and retries automatically', async () => {
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '150' });
    const [ops] = await f.db.insert(departments).values({ companyId: f.company.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [head] = await f.db.insert(agents).values({ companyId: f.company.id, departmentId: ops!.id, subscriptionId: f.agent.subscriptionId, kind: 'head', model: '', roleKey: 'OPS-HEAD', name: 'Operations' }).returning();
    expect((await f.prepare()).json().drain.state).toBe('waiting');
    await until(async () => (await f.prepare()).json().drain.state === 'postponed');
    const notices = await f.db.select().from(jobs).where(eq(jobs.agentId, head!.id));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.prompt).toContain(f.job.id);
    expect(notices[0]!.prompt).toContain('built-in node');
    expect((await f.db.select().from(jobs).where(eq(jobs.id, f.job.id)))[0]).toMatchObject({ status: 'running', error: null });
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, f.job.id));
    await until(async () => (await f.prepare()).json().ready === true);
  });

  it('requires a current node key, and never lets a personal key request a server-wide drain', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', payload: {} })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: 'Bearer wrong' }, payload: {} })).statusCode).toBe(401);
    const [owner] = await f.db.select().from(people);
    const [machine] = await f.db.insert(machines).values({ companyId: f.company.id, personId: owner!.id, machineKey: 'private-host-key', hostname: 'private host' }).returning();
    const [node] = await f.db.insert(nodes).values({ companyId: f.company.id, machineId: machine!.id, keyHash: hashToken('private-node-update-key') }).returning();
    const personal = { authorization: 'Bearer private-node-update-key' };
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: personal, payload: { scope: 'server' } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: personal, payload: {} })).statusCode).toBe(200);
    expect(nodeHeld(f.app.ctx, { kind: 'builtin' })).toBe(false);
    await f.db.update(nodes).set({ keyHash: null }).where(eq(nodes.id, node!.id));
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: personal, payload: {} })).statusCode).toBe(401);
  });

  it('keeps the connection ready while waiting, and releases a hold only after a new boot', async () => {
    const f = await fixture();
    const url = await listen(f.app);
    const node = await connectNode(url, NODE_KEY);
    const boot = { startedAt: '2026-11-04T10:00:00.000Z', machineUpAt: '2026-11-04T09:00:00.000Z', container: 'first' };
    node.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [f.job.id], boot });
    await until(() => f.app.ctx.hub.isReady({ kind: 'builtin' }));
    await f.prepare();
    expect(f.app.ctx.hub.isReady({ kind: 'builtin' })).toBe(true);
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, f.job.id));
    expect((await f.prepare()).json().ready).toBe(true);
    node.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], boot });
    await until(async () => (await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json().builtin.drain?.state === 'restarting');
    node.send({ type: 'hello', version: '0.6.2', loggedIn: true, running: [], boot: { ...boot, startedAt: '2026-11-04T11:00:00.000Z', container: 'second' } });
    await until(async () => (await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json().builtin.drain === null);
  });
});
