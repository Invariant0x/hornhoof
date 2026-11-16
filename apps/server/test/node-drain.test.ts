import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, machines, nodes, people, subscriptions, tasks, testParts, testRuns } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { builtinOf } from '../src/modules/nodes/hub.js';
import { drainPostponed, drainWork } from '../src/modules/updates/drain-work.js';
import { nodeDrain } from '../src/modules/updates/node-drain.js';
import { as, connectNode, listen, setUpCompany, TEST_SECRET, testApp, until } from './helpers.js';
import { BUILTIN } from './builtin.js';

const NODE_KEY = 'builtin-drain-key-0123456789abcdef';
const headers = { authorization: `Bearer ${NODE_KEY}` };

/* The server's clock and its rounds go only as far as a test moves them; they go back after the app has stopped. */
function stillClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  onTestFinished(() => { vi.useRealTimers(); });
}

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
  const [person] = await f.db.select(idOnly(people)).from(people);
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
    expect(nodeDrain(app.ctx, BUILTIN)).toBeNull();
    const response = await app.inject({ method: 'POST', url: '/api/nodes/update', headers, payload: {} });
    expect(response.statusCode).toBe(200);
    expect(nodeDrain(app.ctx, BUILTIN)?.state).toBe('restarting');
  });

  it("counts a built-in node's own work, and none of another machine's built-in node", async () => {
    const f = await fixture();
    const other = 'b0'.repeat(16);
    /* The job of the fixture names no machine: it is of this server's own built-in node, from before machines had theirs. */
    const [there] = await f.db.insert(jobs).values({ companyId: f.company.id, subscriptionId: f.job.subscriptionId, agentId: f.agent.id, kind: 'conversation', prompt: 'On the copy', status: 'running', startedAt: new Date(), timeoutMs: 900_000, builtinMachine: other }).returning();
    const [dept] = await f.db.insert(departments).values({ companyId: f.company.id, name: 'Dev', roleCode: 'DEV' }).returning();
    const [task] = await f.db.insert(tasks).values({ companyId: f.company.id, number: 901, title: 'Run the tests', departmentId: dept!.id }).returning();
    const [run] = await f.db.insert(testRuns).values({ companyId: f.company.id, number: 1, kind: 'tests', departmentId: dept!.id, taskId: task!.id, agentId: f.agent.id, jobId: f.job.id, branch: 'main', command: 'echo ok', parts: 2, timeoutMs: 60_000, status: 'running' }).returning();
    const part = (n: number, builtinMachine: string | null) => f.db.insert(testParts).values({ companyId: f.company.id, runId: run!.id, part: n, status: 'running', builtin: true, builtinMachine, startedAt: new Date() }).returning();
    const [[mine], [theirs]] = [await part(1, null), await part(2, other)];
    const own = await drainWork(f.app.ctx, BUILTIN);
    expect([own.turns.map(turn => turn.id), own.parts.map(one => one.id), own.turnsLeft, own.partsLeft]).toEqual([[f.job.id], [mine!.id], 1, 1]);
    const copy = await drainWork(f.app.ctx, builtinOf(other));
    expect([copy.turns.map(turn => turn.id), copy.parts.map(one => one.id)]).toEqual([[there!.id], [theirs!.id]]);
    /* So this server's own node restarts once its own turn ended, whatever the copy's node still runs. */
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, f.job.id));
    await f.db.update(testParts).set({ status: 'passed' }).where(eq(testParts.id, mine!.id));
    expect((await f.prepare()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
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
    stillClock();
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '1500' });
    const [ops] = await f.db.insert(departments).values({ companyId: f.company.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [head] = await f.db.insert(agents).values({ companyId: f.company.id, departmentId: ops!.id, subscriptionId: f.agent.subscriptionId, kind: 'head', model: '', roleKey: 'OPS-HEAD', name: 'Operations' }).returning();
    expect((await f.prepare()).json().drain.state).toBe('waiting');
    await vi.advanceTimersByTimeAsync(50);
    expect((await f.prepare()).json().drain.state).toBe('postponed');
    const notices = await f.db.select().from(jobs).where(eq(jobs.agentId, head!.id));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.prompt).toContain(f.job.id);
    expect(notices[0]!.prompt).toContain('built-in node');
    expect((await f.db.select().from(jobs).where(eq(jobs.id, f.job.id)))[0]).toMatchObject({ status: 'running', error: null });
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, f.job.id));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.prepare()).json().ready).toBe(true);
  });

  it('names the machine and the turn on it to the head of Operations, and no turn elsewhere', async () => {
    stillClock();
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '3600000' });
    const [ops] = await f.db.insert(departments).values({ companyId: f.company.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [head] = await f.db.insert(agents).values({ companyId: f.company.id, departmentId: ops!.id, subscriptionId: f.agent.subscriptionId, kind: 'head', model: '', roleKey: 'OPS-HEAD', name: 'Operations' }).returning();
    const { key, nodeId } = await serverHostNode(f);
    const [task] = await f.db.insert(tasks).values({ companyId: f.company.id, number: 501, title: 'A long one', body: '', createdByAgentId: f.agent.id }).returning();
    const [turn] = await f.db.insert(jobs).values({ companyId: f.company.id, subscriptionId: f.job.subscriptionId, agentId: f.agent.id, nodeId, taskId: task!.id, kind: 'conversation', prompt: 'On the machine', status: 'running', startedAt: new Date(), timeoutMs: 900_000 }).returning();
    const asMachine = () => f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${key}` }, payload: {} });
    await asMachine();
    await vi.advanceTimersByTimeAsync(50);
    expect((await asMachine()).json().drain.state).toBe('postponed');
    const [notice] = await f.db.select().from(jobs).where(eq(jobs.agentId, head!.id));
    expect(notice!.prompt).toContain('server-host');
    expect(notice!.prompt).toContain(`${turn!.id} (#${task!.number})`);
    expect(notice!.prompt).toContain('No running work was stopped');
    expect(notice!.prompt).toContain('Run parts: none');
    expect(notice!.prompt).not.toContain(f.job.id);
  });

  it("names the machine of another machine's built-in node to the head of Operations", async () => {
    const f = await fixture();
    const other = 'b0'.repeat(16);
    const [ops] = await f.db.insert(departments).values({ companyId: f.company.id, templateKey: 'operations', roleCode: 'OPS' }).returning();
    const [head] = await f.db.insert(agents).values({ companyId: f.company.id, departmentId: ops!.id, subscriptionId: f.agent.subscriptionId, kind: 'head', model: '', roleKey: 'OPS-HEAD', name: 'Operations' }).returning();
    const [person] = await f.db.select(idOnly(people)).from(people);
    await f.db.insert(machines).values({ companyId: f.company.id, personId: person!.id, machineKey: 'studio-key', hostname: 'studio', role: 'data', networkId: other });
    const [turn] = await f.db.insert(jobs).values({ companyId: f.company.id, subscriptionId: f.job.subscriptionId, agentId: f.agent.id, kind: 'conversation', prompt: 'On the copy', status: 'running', startedAt: new Date(), timeoutMs: 900_000, builtinMachine: other }).returning();
    await drainPostponed(f.app.ctx, builtinOf(other), '2026-11-11T13:00:00.000Z', await drainWork(f.app.ctx, builtinOf(other)));
    const [notice] = await f.db.select().from(jobs).where(eq(jobs.agentId, head!.id));
    /* The built-in node of a machine that keeps a copy is named by its machine; this server's own stays "the built-in node". */
    expect(notice!.prompt).toContain('the planned update of the built-in node of studio:');
    expect(notice!.prompt).toContain(turn!.id);
    expect(notice!.prompt).not.toContain(f.job.id);
  });

  it('keeps asking within the lease while postponed, so the machine still says so until the retry', async () => {
    stillClock();
    const f = await fixture({ NODE_DRAIN_MS: '50', NODE_UPDATE_RETRY_MS: '3600000' });
    await f.prepare();
    await vi.advanceTimersByTimeAsync(50);
    expect((await f.prepare()).json().drain.state).toBe('postponed');
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
    expect(nodeDrain(f.app.ctx, BUILTIN)).toMatchObject({ state: 'restarting' });
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, turn[0]!.id));
    expect((await server('POST')).json().ready).toBe(true);
    expect((await server('DELETE')).statusCode).toBe(204);
    expect(nodeDrain(f.app.ctx, BUILTIN)).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId })).toBeNull();
  });

  it('waits an hour and a half and retries a quarter of an hour later, unless set otherwise', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET })).toMatchObject({ nodeDrainMs: 5_400_000, nodeUpdateRetryMs: 900_000 });
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_DRAIN_MS: '', NODE_UPDATE_RETRY_MS: '' })).toMatchObject({ nodeDrainMs: 5_400_000, nodeUpdateRetryMs: 900_000 });
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_DRAIN_MS: '60000', NODE_UPDATE_RETRY_MS: '1000' })).toMatchObject({ nodeDrainMs: 60_000, nodeUpdateRetryMs: 1000 });
  });

  it('keeps the connection ready while waiting, and releases a hold only after a new boot', async () => {
    const f = await fixture();
    const url = await listen(f.app);
    const node = await connectNode(url, NODE_KEY);
    const boot = { startedAt: '2026-11-04T10:00:00.000Z', machineUpAt: '2026-11-04T09:00:00.000Z', container: 'first' };
    node.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [f.job.id], boot });
    await until(() => f.app.ctx.hub.isReady(BUILTIN));
    await f.prepare();
    expect(f.app.ctx.hub.isReady(BUILTIN)).toBe(true);
    await f.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, f.job.id));
    expect((await f.prepare()).json().ready).toBe(true);
    node.send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [], boot });
    await until(async () => (await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json().builtin.drain?.state === 'restarting');
    node.send({ type: 'hello', version: '0.6.2', loggedIn: true, running: [], boot: { ...boot, startedAt: '2026-11-04T11:00:00.000Z', container: 'second' } });
    await until(async () => (await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json().builtin.drain === null);
  });
});
