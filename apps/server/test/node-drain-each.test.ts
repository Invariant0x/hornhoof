import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, machines, nodes, people, subscriptions, tasks } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { enqueueTurn, orchestratorOf, pump } from '../src/modules/conversation/queue.js';
import type { NodeIdentity } from '../src/modules/nodes/hub.js';
import { nodeDrain } from '../src/modules/updates/node-drain.js';
import { as, connectNode, listen, nextOf, setUpCompany, testApp, until, type FakeNode } from './helpers.js';
import { gets } from './test-runs-company.js';
import { BUILTIN } from './builtin.js';

const NODE_KEY = 'builtin-each-key-0123456789abcdef';
const HOST_KEY = 'each-host-machine-key';
const headers = { authorization: `Bearer ${NODE_KEY}` };
const BOOT = { startedAt: '2026-11-05T10:00:00.000Z', machineUpAt: '2026-11-05T09:00:00.000Z', container: 'first' };
const NEW_BOOT = { ...BOOT, startedAt: '2026-11-05T11:00:00.000Z', container: 'second' };

/* The server looks at the nodes that wait once a second, unless a wait or a retry is set shorter. */
const ROUND = 1000;

/* A server on its computer: the built-in node, and the plans a test puts on that computer or on another. Its clock and its
   rounds go only as far as the test moves them; they go back after the app has stopped. */
async function computer(env: NodeJS.ProcessEnv = {}) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const { app, db } = await testApp({ NODE_KEY, HORNHOOF_CONTROL_DIR: mkdtempSync(join(tmpdir(), 'hh-node-each-')), HORNHOOF_HOST_ID: hashToken(`hornhoof-host:${HOST_KEY}`), ...env });
  const ceo = await setUpCompany(app);
  const url = await listen(app);
  const [company] = await db.select().from(companies);
  const [person] = await db.select(idOnly(people)).from(people);
  const [apiKey] = await db.select().from(subscriptions);
  const [host] = await db.insert(machines).values({ companyId: company!.id, personId: person!.id, machineKey: HOST_KEY, hostname: 'host-a' }).returning();
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
  /* Whether a node got a turn of this agent: the agent's turns go out one pump at a time, so once a pump of its own has run,
     every earlier one has sent what it would. */
  const gotTurnOf = async (agentId: string, node: Parameters<typeof gets>[1]) => {
    await pump(app.ctx, agentId);
    return gets(app.ctx, node, 'job.run');
  };
  const server = (method: 'POST' | 'DELETE', names?: string[]) => app.inject({ method, url: '/api/nodes/update', headers, payload: { scope: 'server', ...(names ? { nodes: names } : {}) } });
  return { app, db, ceo, url, company: company!, person: person!, apiKey: apiKey!, host: host!, dept: dept!, online, plan, nodeOf, hire, longTurn, turnFor, statusOf, gotTurnOf, server };
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
    expect(nodeDrain(f.app.ctx, BUILTIN)).toMatchObject({ state: 'restarting' });
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
    expect(nodeDrain(f.app.ctx, BUILTIN)).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toBeNull();
  });

  it('lets go only of the nodes it names, and the node that waits keeps waiting since it began', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const google = await f.plan('antigravity');
    await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const before = (await f.server('POST')).json().drain.since;

    expect((await f.server('DELETE', ['builtin', claude.plan])).statusCode).toBe(204);

    expect(nodeDrain(f.app.ctx, BUILTIN)).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toMatchObject({ state: 'waiting', since: before });
  });

  it('starts the orchestrator on its free node as soon as that one is back, while another node still waits', async () => {
    const f = await computer();
    const builtin = await f.online(NODE_KEY);
    await until(() => f.app.ctx.hub.isReady(BUILTIN));
    const google = await f.plan('antigravity');
    const long = await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const orchestrator = (await orchestratorOf(f.app.ctx, f.company.id))!;
    await f.db.update(agents).set({ subscriptionId: f.apiKey.id }).where(eq(agents.id, orchestrator.id));

    expect((await f.server('POST')).json().free).toEqual(['builtin']);
    const job = await f.turnFor(orchestrator.id);
    expect(await f.gotTurnOf(orchestrator.id, builtin)).toBe(false);

    builtin.send({ type: 'hello', version: '0.7.1', loggedIn: true, running: [], boot: NEW_BOOT });

    expect(await nextOf(builtin, 'job.run')).toMatchObject({ jobId: job });
    expect(await f.statusOf(long.id)).toMatchObject({ status: 'running', error: null });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toMatchObject({ state: 'waiting' });
  });

  it('ignores names it does not know, such as a node of another server on this computer, and holds nothing for them', async () => {
    const f = await computer();
    const res = await f.server('POST', ['a-plan-of-another-server']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: false, free: [], drain: null });
    expect(nodeDrain(f.app.ctx, BUILTIN)).toBeNull();
    expect((await f.server('DELETE', ['a-plan-of-another-server'])).statusCode).toBe(204);
  });

  it('counts only nodes on this computer, so a plan on another machine is not held by a name', async () => {
    const f = await computer();
    const [away] = await f.db.insert(machines).values({ companyId: f.company.id, personId: f.person.id, machineKey: 'another-machine', hostname: 'away' }).returning();
    const remote = await f.plan('claude', away!.id);
    expect((await f.server('POST', [remote.plan])).json()).toMatchObject({ free: [], drain: null });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: remote.nodeId })).toBeNull();
  });

  it('knows only the built-in node without the id of its computer: it holds no other, and calls no other free', async () => {
    const f = await computer({ HORNHOOF_HOST_ID: '' });
    const claude = await f.plan('claude');

    const answer = (await f.server('POST', ['builtin', claude.plan])).json();

    expect(answer).toMatchObject({ ready: true, free: ['builtin'] });
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toBeNull();
  });

  it('takes names only from the built-in key on the whole server: a node key answers for itself', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const asNode = { authorization: `Bearer ${claude.key}` };
    const own = await f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: asNode, payload: { nodes: ['builtin'] } });
    expect(own.statusCode).toBe(200);
    expect(nodeDrain(f.app.ctx, BUILTIN)).toBeNull();
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: claude.nodeId })).toMatchObject({ state: 'restarting' });
    expect((await f.app.inject({ method: 'DELETE', url: '/api/nodes/update', headers: asNode, payload: { scope: 'server', nodes: ['builtin'] } })).statusCode).toBe(403);
  });

  it.each([[['x'.repeat(65)]], [Array.from({ length: 300 }, (_, i) => `plan-${i}`)]])('refuses a list of names no updater sends', async names => {
    const f = await computer();
    expect((await f.server('POST', names)).statusCode).toBe(400);
  });
});

describe('a node that waits for an update takes no new turn', () => {
  /* However long it waits: past an hour and a half, and within the time running work counts as live while its node is
     heard from. */
  const LONG_MS = 95 * 60_000;
  type Fixture = Awaited<ReturnType<typeof computer>>;
  const askFor = (f: Fixture, key: string) => () => f.app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${key}` }, payload: {} });

  /* The clock goes on with no round of the server between, as over a long turn; the node is heard from, and the updater,
     which asks every few seconds, asks again. */
  async function longAfter(f: Fixture, node: FakeNode, id: NodeIdentity, ask: () => Promise<unknown>): Promise<void> {
    vi.setSystemTime(Date.now() + LONG_MS);
    node.send({ type: 'status', loggedIn: true, limits: null });
    await until(() => f.app.ctx.hub.lastSeenAt(id) === Date.now());
    await ask();
    await vi.advanceTimersByTimeAsync(ROUND);
  }

  it("keeps new turns off the only node of a plan however long it waits, the orchestrator's and a head's too, and sends them there once it is updated", async () => {
    const f = await computer();
    const google = await f.plan('antigravity');
    const id = { kind: 'node' as const, nodeId: google.nodeId };
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady(id));
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    const worker = await f.hire('Bob', 'worker', google.plan, google.nodeId);
    const orchestrator = (await orchestratorOf(f.app.ctx, f.company.id))!;
    await f.db.update(agents).set({ subscriptionId: google.plan, nodeId: google.nodeId }).where(eq(agents.id, orchestrator.id));
    const long = await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const ask = askFor(f, google.key);
    expect((await ask()).json()).toMatchObject({ ready: false, drain: { state: 'waiting', turnsLeft: 1 } });
    const turns = [await f.turnFor(worker.id, 'A worker turn'), await f.turnFor(head.id, 'A head turn'), await f.turnFor(orchestrator.id, 'An orchestrator turn')];

    await longAfter(f, node, id, ask);

    expect(nodeDrain(f.app.ctx, id)).toMatchObject({ state: 'waiting', turnsLeft: 1 });
    for (const agent of [worker, head, orchestrator]) expect(await f.gotTurnOf(agent.id, node)).toBe(false);
    expect((await Promise.all(turns.map(f.statusOf))).map(turn => turn.status)).toEqual(['queued', 'queued', 'queued']);
    expect(await f.statusOf(long.id)).toMatchObject({ status: 'running', error: null });

    /* Its last turn ends, the updater hears that the node is free, and the node comes back from its update. */
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, long.id));
    expect((await ask()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
    node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], boot: NEW_BOOT });
    const sent = [await nextOf(node, 'job.run'), await nextOf(node, 'job.run'), await nextOf(node, 'job.run')];
    expect(sent.map(run => run.jobId).sort()).toEqual([...turns].sort());
  });

  it("says in the node's record and on the Machines screen since when it waits, until it is back from its update", async () => {
    const f = await computer();
    const google = await f.plan('antigravity');
    const id = { kind: 'node' as const, nodeId: google.nodeId };
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady(id));
    const long = await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const ask = askFor(f, google.key);
    const record = async () => (await f.db.select({ since: nodes.updateWaitSince }).from(nodes).where(eq(nodes.id, google.nodeId)))[0]!.since?.toISOString() ?? null;
    const shown = async () => (await f.app.inject({ url: '/api/machines', ...as(f.ceo) })).json().machines.find((m: { id: string }) => m.id === f.host.id).drain ?? null;
    expect([await record(), await shown()]).toEqual([null, null]);

    const since = new Date().toISOString();
    await ask();

    await until(async () => (await record()) === since);
    expect(await shown()).toEqual({ state: 'waiting', turnsLeft: 1, partsLeft: 0, since });
    await longAfter(f, node, id, ask);
    expect([await record(), await shown()]).toEqual([since, { state: 'waiting', turnsLeft: 1, partsLeft: 0, since }]);
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, long.id));
    expect((await ask()).json().drain.state).toBe('restarting');
    expect(await record()).toBe(since);
    node.send({ type: 'hello', version: '0.7.0', loggedIn: true, running: [], boot: NEW_BOOT });
    await until(async () => (await record()) === null);
    expect(await shown()).toBeNull();
  });

  it('sends a new turn to another ready machine of its plan, a head\'s too, and keeps one whose agent holds a task in progress for its own machine', async () => {
    const f = await computer();
    const [away] = await f.db.insert(machines).values({ companyId: f.company.id, personId: f.person.id, machineKey: 'another-machine', hostname: 'away' }).returning();
    const google = await f.plan('antigravity');
    const other = await f.nodeOf(google.plan, away!.id);
    const id = { kind: 'node' as const, nodeId: google.nodeId };
    const here = await f.online(google.key);
    const there = await f.online(other.key);
    await until(() => f.app.ctx.hub.isReady(id) && f.app.ctx.hub.isReady({ kind: 'node', nodeId: other.nodeId }));
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    const orchestrator = (await orchestratorOf(f.app.ctx, f.company.id))!;
    await f.db.update(agents).set({ subscriptionId: google.plan, nodeId: google.nodeId }).where(eq(agents.id, orchestrator.id));
    await f.db.insert(tasks).values({ companyId: f.company.id, number: 7, title: 'Held', body: '', status: 'working', assigneeAgentId: orchestrator.id, createdByAgentId: orchestrator.id });
    await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const ask = askFor(f, google.key);
    await ask();

    const free = await f.turnFor(head.id);
    const held = await f.turnFor(orchestrator.id);
    await longAfter(f, here, id, ask);

    expect(await nextOf(there, 'job.run')).toMatchObject({ jobId: free });
    expect(await f.statusOf(free)).toMatchObject({ nodeId: other.nodeId });
    expect(await f.gotTurnOf(orchestrator.id, here)).toBe(false);
    expect(await f.gotTurnOf(orchestrator.id, there)).toBe(false);
    expect(await f.statusOf(held)).toMatchObject({ status: 'queued' });
  });

  it('keeps a head off the built-in node however long it waits, when the company key runs it', async () => {
    const f = await computer();
    const builtin = await f.online(NODE_KEY);
    await until(() => f.app.ctx.hub.isReady(BUILTIN));
    const head = await f.hire('Hana', 'head', f.apiKey.id);
    await f.longTurn(await f.hire('Dev', 'worker', f.apiKey.id), null);
    const ask = () => f.server('POST');
    await ask();

    const job = await f.turnFor(head.id);
    await longAfter(f, builtin, BUILTIN, ask);

    expect(nodeDrain(f.app.ctx, BUILTIN)).toMatchObject({ state: 'waiting', turnsLeft: 1 });
    expect(await f.gotTurnOf(head.id, builtin)).toBe(false);
    expect((await f.statusOf(job)).status).toBe('queued');
  });

  /* As on 16.11: the updater asked, took a moment's 404 for a server from before and went, and then the long turn ended. */
  it('lets the orchestrator in once an updater that went away no longer holds the node', async () => {
    const f = await computer();
    const google = await f.plan('antigravity');
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }));
    const orchestrator = (await orchestratorOf(f.app.ctx, f.company.id))!;
    await f.db.update(agents).set({ subscriptionId: google.plan, nodeId: google.nodeId }).where(eq(agents.id, orchestrator.id));
    const long = await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    await askFor(f, google.key)();
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, long.id));
    await vi.advanceTimersByTimeAsync(ROUND);
    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toMatchObject({ state: 'waiting', turnsLeft: 0, partsLeft: 0 });

    const job = await f.turnFor(orchestrator.id);
    await vi.advanceTimersByTimeAsync(ROUND);
    expect(await f.gotTurnOf(orchestrator.id, node)).toBe(false);
    /* Two minutes with nobody asking end the hold. */
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    expect(nodeDrain(f.app.ctx, { kind: 'node', nodeId: google.nodeId })).toBeNull();
    expect(await nextOf(node, 'job.run')).toMatchObject({ jobId: job });
  });

  it('tells the updater that comes back that the node is free, once its work ended while nobody asked', async () => {
    const f = await computer();
    const google = await f.plan('antigravity');
    const long = await f.longTurn(await f.hire('Dev', 'worker', google.plan, google.nodeId), google.nodeId);
    const ask = askFor(f, google.key);
    expect((await ask()).json()).toMatchObject({ ready: false, drain: { state: 'waiting' } });
    await f.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, long.id));
    await vi.advanceTimersByTimeAsync(ROUND);
    expect((await ask()).json()).toMatchObject({ ready: true, drain: { state: 'restarting' } });
  });

  it('keeps a head waiting on a node that restarts when its plan has no other machine', async () => {
    const f = await computer();
    const google = await f.plan('antigravity');
    const node = await f.online(google.key);
    await until(() => f.app.ctx.hub.isReady({ kind: 'node', nodeId: google.nodeId }));
    const head = await f.hire('Hana', 'head', google.plan, google.nodeId);
    await askFor(f, google.key)();
    const job = await f.turnFor(head.id);
    await vi.advanceTimersByTimeAsync(ROUND);
    expect(await f.gotTurnOf(head.id, node)).toBe(false);
    expect((await f.statusOf(job)).status).toBe('queued');
  });
});

describe('the update screen', () => {
  const screen = async (f: Awaited<ReturnType<typeof computer>>) => (await f.app.inject({ url: '/api/updates', ...as(f.ceo) })).json().nodeWaits;

  it('says of each node what it waits for and since when', async () => {
    const f = await computer();
    const claude = await f.plan('claude');
    const google = await f.plan('antigravity');
    const dev = await f.hire('Dev', 'worker', google.plan, google.nodeId);
    const [task] = await f.db.insert(tasks).values({ companyId: f.company.id, number: 251, title: 'A long one', body: '', createdByAgentId: dev.id }).returning();
    const turn = await f.longTurn(dev, google.nodeId);
    await f.db.update(jobs).set({ taskId: task!.id }).where(eq(jobs.id, turn.id));
    const since = (await f.server('POST')).json().drain.since;

    const waits = await screen(f);

    expect(waits).toHaveLength(3);
    expect(waits.find((w: { node: string }) => w.node === 'builtin')).toMatchObject({ provider: null, hostname: null, drain: { state: 'restarting' }, work: [] });
    expect(waits.find((w: { node: string }) => w.node === claude.nodeId)).toMatchObject({ provider: 'claude', hostname: 'host-a', drain: { state: 'restarting' }, work: [] });
    expect(waits.find((w: { node: string }) => w.node === google.nodeId)).toMatchObject({
      provider: 'antigravity',
      hostname: 'host-a',
      drain: { state: 'waiting', turnsLeft: 1, since },
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
