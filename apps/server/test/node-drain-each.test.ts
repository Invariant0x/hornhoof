import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, machines, nodes, people, subscriptions, tasks } from '../src/db/schema.js';
import { enqueueTurn, orchestratorOf } from '../src/modules/conversation/queue.js';
import { nodeDrain, nodeHeldLong } from '../src/modules/updates/node-drain.js';
import { as, connectNode, listen, setUpCompany, TEST_SECRET, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'builtin-each-key-0123456789abcdef';
const HOST_KEY = 'each-host-machine-key';
const headers = { authorization: `Bearer ${NODE_KEY}` };
const BOOT = { startedAt: '2026-11-05T10:00:00.000Z', machineUpAt: '2026-11-05T09:00:00.000Z', container: 'first' };
const NEW_BOOT = { ...BOOT, startedAt: '2026-11-05T11:00:00.000Z', container: 'second' };

/* A server on its computer: the built-in node, and the plans a test puts on that computer or on another. */
async function computer(env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-node-each-')), HORNHOOF_HOST_ID: hashToken(`hornhoof-host:${HOST_KEY}`), ...env });
  const ceo = await setUpCompany(app);
  const url = await listen(app);
  const [company] = await db.select().from(companies);
  const [person] = await db.select({ id: people.id }).from(people);
  const [apiKey] = await db.select().from(subscriptions);
  const [host] = await db.insert(machines).values({ companyId: company!.id, personId: person!.id, machineKey: HOST_KEY, hostname: 'a-host' }).returning();
  const [dept] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();

  const online = async (key: string) => {
    const node = await connectNode(url, key);
    onTestFinished(() => node.close());
    node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], boot: BOOT });
    return node;
  };
  const plan = async (provider: 'claude' | 'antigravity', machineId = host!.id) => {
    const [sub] = await db.insert(subscriptions).values({ companyId: company!.id, provider, kind: 'personal', label: provider, ownerPersonId: person!.id, status: 'ready' }).returning();
    return { ...(await nodeOf(sub!.id, machineId)), plan: sub!.id };
  };
  const nodeOf = async (subscriptionId: string, machineId: string) => {
    const key = `node-key-${subscriptionId}-${machineId}`;
    const [row] = await db.insert(nodes).values({ companyId: company!.id, machineId, subscriptionId, keyHash: hashToken(key), status: 'ready', version: '0.7.0' }).returning();
    return { key, nodeId: row!.id };
  };
  const hire = async (name: string, kind: 'head' | 'worker', subscriptionId: string, nodeId: string | null = null) =>
    (await db.insert(agents).values({ companyId: company!.id, departmentId: dept!.id, subscriptionId, nodeId, kind, model: '', roleKey: kind === 'head' ? 'DEV-HEAD' : 'DEV-BE', name }).returning())[0]!;
  const longTurn = async (agent: { id: string; subscriptionId: string | null }, nodeId: string | null) =>
    (await db.insert(jobs).values({ companyId: company!.id, subscriptionId: agent.subscriptionId!, agentId: agent.id, nodeId, kind: 'conversation', prompt: 'A long one', status: 'running', startedAt: new Date(), timeoutMs: 9_000_000 }).returning())[0]!;
  const turnFor = (agentId: string, prompt = 'Your turn') => enqueueTurn(app.ctx, { companyId: company!.id, agentId, prompt, createdBy: null });
  const statusOf = async (jobId: string) => (await db.select({ status: jobs.status, nodeId: jobs.nodeId, error: jobs.error }).from(jobs).where(eq(jobs.id, jobId)))[0]!;
  const server = (method: 'POST' | 'DELETE', names?: string[]) => app.inject({ method, url: '/api/nodes/update', headers, payload: { scope: 'server', ...(names ? { nodes: names } : {}) } });
  return { app, db, ceo, url, company: company!, person: person!, apiKey: apiKey!, host: host!, dept: dept!, online, plan, nodeOf, hire, longTurn, turnFor, statusOf, server };
}

/* The next turn a node gets, past what else it hears; null when none comes in time. It looks at what has arrived rather
   than waiting on next(), which would swallow the message after a timeout. */
async function nextTurn(node: FakeNode, ms = 3000): Promise<{ jobId: string } | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!node.queued()) {
      await new Promise(done => setTimeout(done, 15));
      continue;
    }
    const m = await node.next();
    if (m.type === 'job.run') return m as { type: 'job.run'; jobId: string };
  }
  return null;
}

describe('each node on the server computer is replaced on its own', () => {
  it('names the free ones at once while one runs a long turn, and that turn goes on', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const google = await f.plan('antigravity');
    const dev = await f.hire('Dev', 'worker', google.plan, google.nodeId);
    const turn = await f.longTurn(dev, google.nodeId);

    const answer = (await f.server('POST')).json();

    expect(answer.ready).toBe(false);
    expect(answer.free.sort()).toEqual(['builtin', claude.plan].sort());
    expect(answer.drain).toMatchObject({ state: 'waiting', turnsLeft: 1 });
    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toMatchObject({ state: 'restarting' });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toMatchObject({ state: 'restarting' });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toMatchObject({ state: 'waiting', turnsLeft: 1 });
    expect(await f.statusOf(turn.id)).toMatchObject({ status: 'running', error: null });
  });

  it('holds only the nodes it is told run another image, so one already replaced takes work', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const google = await f.plan('antigravity');

    const answer = (await f.server('POST', [google.plan])).json();

    expect(answer).toMatchObject({ ready: true, free: [google.plan], drain: { state: 'restarting' } });
    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toBeNull();
  });

  it('lets go only of the nodes it names, and the node that waits keeps its deadline', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const google = await f.plan('antigravity');
    await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const before = (await f.server('POST')).json().drain.until;

    expect((await f.server('DELETE', ['builtin', claude.plan])).statusCode).toBe(204);

    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toMatchObject({ state: 'waiting', until: before });
  });

  it('starts the orchestrator on its free node as soon as that one is back, while another node still waits', async () => {
    const f = await computer();
    const builtin = await f.online(NODE_KEY);
    await until(() => f.app.ctx.hub.isReady({ kind: 'builtin' }));
    const google = await f.plan('antigravity');
    const long = await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const orchestrator = (await orchestratorOf(f.app.ctx, f.company.id))!;
    await f.db.update(agents).set({ subscriptionId: f.apiKey.id }).where(eq(agents.id, orchestrator.id));

    expect((await f.server('POST')).json().free).toEqual(['builtin']);
    const job = await f.turnFor(orchestrator.id);
    expect(await nextTurn(builtin, 200)).toBeNull();

    builtin.send({ type: 'hello', version: '0.7.1', loggedIn: true, running: [], boot: NEW_BOOT });

    expect(await nextTurn(builtin)).toMatchObject({ jobId: job });
    expect(await f.statusOf(long.id)).toMatchObject({ status: 'running', error: null });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toMatchObject({ state: 'waiting' });
  });

  it('ignores names it does not know, such as a node of another server on this computer, and holds nothing for them', async () => {
    const f = await computer();
    const res = await f.server('POST', ['a-plan-of-another-server']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: false, free: [], drain: null });
    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toBeNull();
    expect((await f.server('DELETE', ['a-plan-of-another-server'])).statusCode).toBe(204);
  });

  it('counts only nodes on this computer, so a plan on another machine is not held by a name', async () => {
    const f = await computer();
    const [away] = await f.db.insert(machines).values({ companyId: f.company.id, personId: f.person.id, machineKey: 'another-machine', hostname: 'away' }).returning();
    const remote = await f.plan('claude', away!.id);
    expect((await f.server('POST', [remote.plan])).json()).toMatchObject({ free: [], drain: null });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: remote.nodeId })).toBeNull();
  });

  it('takes names only from the built-in key on the whole server: a node key answers for itself', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const asNode = { authorization: `Bearer ${claude.key}` };
    const own = await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: asNode, payload: { nodes: ['builtin'] } });
    expect(own.statusCode).toBe(200);
    expect(nodeDrain(f.app.ctx, { kind: 'builtin' })).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toMatchObject({ state: 'restarting' });
    expect((await f.app.inject({ method: 'DELETE', url: '/api/nodes/update', headers: asNode, payload: { scope: 'server', nodes: ['builtin'] } })).statusCode).toBe(403);
  });

  it.each([[['x'.repeat(65)]], [Array.from({ length: 300 }, (_, i) => `plan-${i}`)]])('refuses a list of names no updater sends', async names => {
    const f = await computer();
    expect((await f.server('POST', names)).statusCode).toBe(400);
  });
});

describe('the orchestrator and the heads while their node waits', () => {
  const HOLD = 400;

  it('sets the limit in the open: three minutes, unless set otherwise', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET })).toMatchObject({ nodeLeaderHoldMs: 180_000 });
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_LEADER_HOLD_MS: '60000' })).toMatchObject({ nodeLeaderHoldMs: 60_000 });
  });

  it('holds a head on the only node of its plan up to the limit and no longer, and leaves the long turn and the workers as they are', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: String(HOLD) });
    const google = await f.plan('antigravity');
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }));
    const dev = await f.hire('Dev', 'worker', google.plan, google.nodeId);
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    const worker = await f.hire('Bob', 'worker', google.plan, google.nodeId);
    const long = await f.longTurn(dev, google.nodeId);
    await f.server('POST');
    const from = Date.now();

    const waiting = await f.turnFor(worker.id, 'A worker turn');
    const led = await f.turnFor(head.id, 'A head turn');
    expect((await f.statusOf(led)).status).toBe('queued');

    const run = await nextTurn(node);

    expect(run).toMatchObject({ jobId: led });
    expect(Date.now() - from).toBeGreaterThanOrEqual(HOLD - 50);
    expect(await f.statusOf(long.id)).toMatchObject({ status: 'running', error: null });
    expect(await nextTurn(node, 300)).toBeNull();
    expect((await f.statusOf(waiting)).status).toBe('queued');
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })?.state).toBe('waiting');
  });

  it('lets the orchestrator in the same way', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: String(HOLD) });
    const google = await f.plan('antigravity');
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }));
    const orchestrator = (await orchestratorOf(f.app.ctx, f.company.id))!;
    await f.db.update(agents).set({ subscriptionId: google.plan, nodeId: google.nodeId }).where(eq(agents.id, orchestrator.id));
    await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    await f.server('POST');

    const job = await f.turnFor(orchestrator.id);

    expect((await f.statusOf(job)).status).toBe('queued');
    expect(await nextTurn(node)).toMatchObject({ jobId: job });
  });

  it('holds a head on the built-in node up to the limit too, when the company key runs it', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: String(HOLD) });
    const builtin = await f.online(NODE_KEY);
    await until(() => f.app.ctx.hub.isReady({ kind: 'builtin' }));
    const head = await f.hire('Hana', 'head', f.apiKey.id);
    await f.longTurn(await f.hire('Dev', 'worker', f.apiKey.id), null);
    await f.server('POST');
    const job = await f.turnFor(head.id);
    expect((await f.statusOf(job)).status).toBe('queued');
    expect(await nextTurn(builtin)).toMatchObject({ jobId: job });
  });

  it('sends a head that holds a task to another machine of its plan past the limit, not onto the node that waits', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: String(HOLD) });
    const [away] = await f.db.insert(machines).values({ companyId: f.company.id, personId: f.person.id, machineKey: 'another-machine', hostname: 'away' }).returning();
    const google = await f.plan('antigravity');
    const other = await f.nodeOf(google.plan, away!.id);
    const here = await f.online(google.key);
    const there = await f.online(other.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }) && f.app.ctx.hub.isReady({ kind: 'node', nodeId: other.nodeId }));
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    await f.db.insert(tasks).values({ companyId: f.company.id, number: 7, title: 'Held', body: '', status: 'working', assigneeAgentId: head.id, createdByAgentId: head.id });
    await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${google.key}` }, payload: {} });

    const job = await f.turnFor(head.id);
    expect((await f.statusOf(job)).status).toBe('queued');

    expect(await nextTurn(there)).toMatchObject({ jobId: job });
    expect(await f.statusOf(job)).toMatchObject({ nodeId: other.nodeId });
    expect(await nextTurn(here, 100)).toBeNull();
    expect((await f.db.select({ nodeId: agents.nodeId }).from(agents).where(eq(agents.id, head.id)))[0]!.nodeId).toBe(other.nodeId);
  });

  it('stays on its own node past the limit when every machine of its plan waits, and starts on that one', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: String(HOLD) });
    const [away] = await f.db.insert(machines).values({ companyId: f.company.id, personId: f.person.id, machineKey: 'another-machine', hostname: 'away' }).returning();
    const google = await f.plan('antigravity');
    const other = await f.nodeOf(google.plan, away!.id);
    const first = await f.online(google.key);
    const own = await f.online(other.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }) && f.app.ctx.hub.isReady({ kind: 'node', nodeId: other.nodeId }));
    const dev = await f.hire('Dev', 'worker', google.plan, google.nodeId);
    await f.longTurn(dev, google.nodeId);
    await f.longTurn(await f.hire('Bob', 'worker', google.plan, other.nodeId), other.nodeId);
    const head = await f.hire('Hana', 'head', google.plan, other.nodeId);
    for (const key of [google.key, other.key]) await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${key}` }, payload: {} });

    const job = await f.turnFor(head.id);

    expect(await nextTurn(own)).toMatchObject({ jobId: job });
    expect(await nextTurn(first, 100)).toBeNull();
  });

  it('starts the limit over when the node waits again after its update was put off', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: '300', NODE_DRAIN_MS: '600', NODE_UPDATE_RETRY_MS: '100' });
    const google = await f.plan('antigravity');
    await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const node = { kind: 'node' as const, nodeId: google.nodeId };
    const ask = () => f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${google.key}` }, payload: {} });
    await ask();
    await until(() => nodeHeldLong(f.app.ctx, node));
    await until(async () => (await ask()).json().drain.state === 'postponed');
    expect(nodeHeldLong(f.app.ctx, node)).toBe(false);
    await until(async () => (await ask()).json().drain.state === 'waiting');
    expect(nodeHeldLong(f.app.ctx, node)).toBe(false);
    await until(() => nodeHeldLong(f.app.ctx, node));
  });

  it('never sends a head onto a node that restarts, however long it takes: it goes to another machine of its plan', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: String(HOLD) });
    const [away] = await f.db.insert(machines).values({ companyId: f.company.id, personId: f.person.id, machineKey: 'another-machine', hostname: 'away' }).returning();
    const google = await f.plan('antigravity');
    const other = await f.nodeOf(google.plan, away!.id);
    const here = await f.online(google.key);
    const there = await f.online(other.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }) && f.app.ctx.hub.isReady({ kind: 'node', nodeId: other.nodeId }));
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    await f.db.insert(tasks).values({ companyId: f.company.id, number: 8, title: 'Held', body: '', status: 'working', assigneeAgentId: head.id, createdByAgentId: head.id });
    expect((await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${google.key}` }, payload: {} })).json().drain.state).toBe('restarting');

    const job = await f.turnFor(head.id);
    expect((await f.statusOf(job)).status).toBe('queued');

    expect(await nextTurn(there)).toMatchObject({ jobId: job });
    expect(await nextTurn(here, 100)).toBeNull();
  });

  it('keeps a head waiting on a node that restarts when its plan has no other machine', async () => {
    const f = await computer({ NODE_LEADER_HOLD_MS: '50' });
    const google = await f.plan('antigravity');
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }));
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${google.key}` }, payload: {} });
    const job = await f.turnFor(head.id);
    /* Longer than the look at the waits that lets the leaders in, at most a second apart. */
    expect(await nextTurn(node, 1500)).toBeNull();
    expect((await f.statusOf(job)).status).toBe('queued');
  });
});

describe('the update screen', () => {
  const screen = async (f: Awaited<ReturnType<typeof computer>>) => (await f.app.inject({ url: '/api/updates', ...as(f.ceo) })).json().nodeWaits;

  it('says of each node what it waits for and until when', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const google = await f.plan('antigravity');
    const dev = await f.hire('Dev', 'worker', google.plan, google.nodeId);
    const [task] = await f.db.insert(tasks).values({ companyId: f.company.id, number: 251, title: 'A long one', body: '', createdByAgentId: dev.id }).returning();
    const turn = await f.longTurn(dev, google.nodeId);
    await f.db.update(jobs).set({ taskId: task!.id }).where(eq(jobs.id, turn.id));
    const until = (await f.server('POST')).json().drain.until;

    const waits = await screen(f);

    expect(waits).toHaveLength(3);
    expect(waits.find((w: { node: string }) => w.node === 'builtin')).toMatchObject({ provider: null, hostname: null, drain: { state: 'restarting' }, work: [] });
    expect(waits.find((w: { node: string }) => w.node === claude.nodeId)).toMatchObject({ provider: 'claude', hostname: 'a-host', drain: { state: 'restarting' }, work: [] });
    expect(waits.find((w: { node: string }) => w.node === google.nodeId)).toMatchObject({
      provider: 'antigravity',
      hostname: 'a-host',
      drain: { state: 'waiting', turnsLeft: 1, until },
      work: [{ agent: 'Dev', task: 251 }],
    });
  });

  it('is empty when no node waits', async () => {
    const f = await computer();
    expect(await screen(f)).toEqual([]);
  });

  it('never names a node of another company or the agents and tasks of another company', async () => {
    const f = await computer();
    const [other] = await f.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [person] = await f.db.insert(people).values({ companyId: other!.id, name: 'Olga', email: 'olga@other.test', status: 'active', scopeKind: 'company' }).returning();
    const [sub] = await f.db.insert(subscriptions).values({ companyId: other!.id, provider: 'claude', kind: 'personal', label: 'theirs', ownerPersonId: person!.id, status: 'ready' }).returning();
    const [machine] = await f.db.insert(machines).values({ companyId: other!.id, personId: person!.id, machineKey: 'theirs', hostname: 'their-box' }).returning();
    const [node] = await f.db.insert(nodes).values({ companyId: other!.id, machineId: machine!.id, subscriptionId: sub!.id, keyHash: hashToken('their-node-key'), status: 'ready', version: '0.7.0' }).returning();
    const [secret] = await f.db.insert(agents).values({ companyId: other!.id, subscriptionId: sub!.id, kind: 'worker', model: '', roleKey: 'DEV-BE', name: 'Secret agent' }).returning();
    await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: 'Bearer their-node-key' }, payload: {} });
    await f.db.insert(jobs).values({ companyId: other!.id, subscriptionId: sub!.id, agentId: secret!.id, nodeId: null, kind: 'conversation', prompt: 'Theirs', status: 'running', startedAt: new Date(), timeoutMs: 900_000 });
    await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers, payload: {} });

    const waits = await screen(f);

    expect(waits.map((w: { node: string }) => w.node)).toEqual(['builtin']);
    expect(waits[0]).toMatchObject({ drain: { state: 'waiting', turnsLeft: 1 }, work: [] });
    expect(JSON.stringify(waits)).not.toContain('Secret agent');
    expect(JSON.stringify(waits)).not.toContain('their-box');
    expect(JSON.stringify(waits)).not.toContain(node!.id);
  });
});
