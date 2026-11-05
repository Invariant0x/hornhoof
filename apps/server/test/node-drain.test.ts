import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, machines, nodes, people, subscriptions, tasks } from '../src/db/schema.js';
import { nodeDrain } from '../src/modules/updates/node-drain.js';
import { as, connectNode, listen, setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';

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

const HOST_KEY = 'server-host-machine-key';

/* A personal node on the machine the server runs on. */
async function serverHostNode(f: Awaited<ReturnType<typeof fixture>>) {
  const key = 'personal-drain-key-0123456789abcdef';
  const [person] = await f.db.select({ id: people.id }).from(people);
  const [machine] = await f.db.insert(machines).values({ companyId: f.company.id, personId: person!.id, machineKey: HOST_KEY, hostname: 'server-host' }).returning();
  const [node] = await f.db.insert(nodes).values({ companyId: f.company.id, machineId: machine!.id, subscriptionId: f.job.subscriptionId, keyHash: hashToken(key), status: 'ready', version: '0.7.0' }).returning();
  return { key, nodeId: node!.id };
}

describe('planned node updates', () => {
  it.each([['broken JSON', '{not json'], ['the wrong shape', JSON.stringify([{ key: 'builtin' }])]])('starts with no wait, says so and can wait again when the saved waits are %s', async (_name, saved) => {
    const control = mkdtempSync(join(tmpdir(), 'hh-node-drain-'));
    writeFileSync(join(control, 'node-drains.json'), saved);
    const logs: string[] = [];
    const { app } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: control }, { level: 'error', stream: { write: (line: string) => void logs.push(line) } });
    expect(logs.join('\n')).toContain('node-drains.json');
    expect(nodeDrain(app.ctx, { kind: 'builtin' })).toBeNull();
    const response = await app.inject({ method: 'POST', url: '/api/nodes/update', headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(nodeDrain(app.ctx, { kind: 'builtin' })?.state).toBe('restarting');
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
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '1500' });
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
    await until(async () => (await f.prepare()).json().ready === true, 5000);
  });

  it('names the machine and the turn on it to the head of Operations, and no turn elsewhere', async () => {
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '3600000' });
    const [ops] = await f.db.insert(departments).values({ companyId: f.company.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [head] = await f.db.insert(agents).values({ companyId: f.company.id, departmentId: ops!.id, subscriptionId: f.agent.subscriptionId, kind: 'head', model: '', roleKey: 'OPS-HEAD', name: 'Operations' }).returning();
    const { key, nodeId } = await serverHostNode(f);
    const [task] = await f.db.insert(tasks).values({ companyId: f.company.id, number: 501, title: 'A long one', body: '', createdByAgentId: f.agent.id }).returning();
    const [turn] = await f.db.insert(jobs).values({ companyId: f.company.id, subscriptionId: f.job.subscriptionId, agentId: f.agent.id, nodeId, taskId: task!.id, kind: 'conversation', prompt: 'On the machine', status: 'running', startedAt: new Date(), timeoutMs: 900_000 }).returning();
    const asMachine = () => f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${key}` }, payload: {} });
    await asMachine();
    await until(async () => (await asMachine()).json().drain.state === 'postponed');
    await until(async () => (await f.db.select().from(jobs).where(eq(jobs.agentId, head!.id))).length === 1);
    const [notice] = await f.db.select().from(jobs).where(eq(jobs.agentId, head!.id));
    expect(notice!.prompt).toContain('server-host');
    expect(notice!.prompt).toContain(`${turn!.id} (#${task!.number})`);
    expect(notice!.prompt).toContain('No running work was stopped');
    expect(notice!.prompt).toContain('Run parts: none');
    expect(notice!.prompt).not.toContain(f.job.id);
  });

  it('keeps asking within the lease while postponed, so the machine still says so until the retry', async () => {
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '3600000' });
    await f.prepare();
    await until(async () => (await f.prepare()).json().drain.state === 'postponed');
    expect((await f.prepare()).json().pollAfterMs).toBeLessThan(60_000);
  });

  it('requires a current node key', async () => {
    const f = await fixture();
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', payload: {} })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: 'Bearer wrong' }, payload: {} })).statusCode).toBe(401);
    expect((await f.app.inject({ method: 'DELETE', url: '/api/nodes/update' })).statusCode).toBe(401);
  });

  it('never lets a personal key wait for or release the whole server', async () => {
    const f = await fixture();
    const { key } = await serverHostNode(f);
    const asNode = { authorization: `Bearer ${key}` };
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: asNode, payload: { scope: 'server' } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: 'DELETE', url: '/api/nodes/update', headers: asNode, payload: { scope: 'server' } })).statusCode).toBe(403);
  });

  it('waits for every node on the server host with the built-in key, and gives them all back on release', async () => {
    const f = await fixture({ HORNHOOF_HOST_ID: hashToken(`hornhoof-host:${HOST_KEY}`) });
    const { nodeId } = await serverHostNode(f);
    const server = (method: 'POST' | 'DELETE') => f.app.inject({ method, url: '/api/nodes/update', headers, payload: { scope: 'server' } });
    const turn = await f.db.insert(jobs).values({ companyId: f.company.id, subscriptionId: f.job.subscriptionId, agentId: f.agent.id, nodeId, kind: 'conversation', prompt: 'On the host', status: 'running', startedAt: new Date(), timeoutMs: 900_000 }).returning();
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, f.job.id));
    expect((await server('POST')).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });
    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toMatchObject({ state: 'restarting' });
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, turn[0]!.id));
    expect((await server('POST')).json().ready).toBe(true);
    expect((await server('DELETE')).statusCode).toBe(204);
    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId })).toBeNull();
  });

  it('waits an hour and a half and retries a quarter of an hour later, unless set otherwise', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET })).toMatchObject({ nodeDrainMs: 5_400_000, nodeUpdateRetryMs: 900_000 });
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_DRAIN_MS: '60000', NODE_UPDATE_RETRY_MS: '1000' })).toMatchObject({ nodeDrainMs: 60_000, nodeUpdateRetryMs: 1000 });
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
