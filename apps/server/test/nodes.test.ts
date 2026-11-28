import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, departments, companies, jobs, machines, nodeCodes, nodeConnections, nodes, people, subscriptions, tasks, testParts, testRuns } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { idOnly } from '../src/db/selections.js';
import { receiveNodeMessage } from '../src/modules/nodes/lifecycle.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';
import { BUILTIN } from './builtin.js';

const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };

const codeOf = (command: string) => command.split('--join ')[1]!;
const join = (app: FastifyInstance, code: string, extra: object = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, ...MACHINE, ...extra }, headers });

async function connected(providers: string[], env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp(env);
  const ceo = await setUpCompany(app);
  const res = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(ceo) });
  return { app, db, ceo, code: codeOf(res.json().command), ids: res.json().subscriptions.map((s: { id: string }) => s.id) as string[] };
}

/* Legacy installs could have a hidden, still-live duplicate code. The join defenses must still handle those rows. */
async function legacyCopy(db: Awaited<ReturnType<typeof testApp>>['db'], code: string): Promise<string> {
  const [row] = await db.select().from(nodeCodes).where(eq(nodeCodes.codeHash, hashToken(code)));
  const copy = `legacy-${code}`;
  await db.insert(nodeCodes).values({ ...row!, codeHash: hashToken(copy), commandEnc: null });
  return copy;
}

const machinesOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json().machines;

describe('POST /api/nodes/join', () => {
  it('refuses an old server transport link before a valid node key can change current state', async () => {
    const { app, db, code, ids } = await connected(['codex']);
    const url = await listen(app);
    const made = (await join(app, code)).json().nodes[0] as { nodeId: string; key: string };
    const identity = { kind: 'node' as const, nodeId: made.nodeId, keyHash: hashToken(made.key) };
    await connectNode(url, made.key);
    let oldLink: string | undefined;
    await until(async () => { oldLink = (await db.select(idOnly(nodeConnections)).from(nodeConnections).where(eq(nodeConnections.nodeId, made.nodeId)))[0]?.id; return oldLink !== undefined; });
    const current = await connectNode(url, made.key);
    current.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await until(async () => (await db.select().from(nodes).where(eq(nodes.id, made.nodeId)))[0]?.status === 'ready');
    expect(app.ctx.hub.isCurrentLink(identity, oldLink!)).toBe(false);
    await receiveNodeMessage(app.ctx, identity, { type: 'status', loggedIn: false, limits: null }, { linkId: oldLink! });
    expect((await db.select().from(nodes).where(eq(nodes.id, made.nodeId)))[0]!.status).toBe('ready');
    expect((await db.select().from(subscriptions).where(eq(subscriptions.id, ids[0]!)))[0]!.status).toBe('ready');
  });

  it('gives every subscription of the code a node of its own with its own key on one machine', async () => {
    const { app, db, ceo, code, ids } = await connected(['claude', 'codex']);
    const res = await join(app, code);
    expect(res.statusCode).toBe(200);
    const { machine, nodes: made } = res.json();
    expect(made.map((n: { subscriptionId: string }) => n.subscriptionId).sort()).toEqual([...ids].sort());
    expect(new Set(made.map((n: { key: string }) => n.key)).size).toBe(2);
    for (const id of ids) {
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(row).toMatchObject({ status: 'needs_login' });
      const [node] = await db.select().from(nodes).where(eq(nodes.subscriptionId, id));
      /* A plan's first node takes the plan's id, as nodes had before they had rows of their own. */
      expect(node).toMatchObject({ id, machineId: machine.id, status: 'needs_login' });
      expect(node!.keyHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const list = await machinesOf(app, ceo);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: machine.id, hostname: 'dev-mac', os: 'darwin', arch: 'arm64', owner: { name: 'Ivan' }, online: false, plans: [{ provider: 'claude' }, { provider: 'codex' }] });
    expect(JSON.stringify(await app.inject({ url: '/api/subscriptions', ...as(ceo) }).then(r => r.json()))).not.toContain(made[0].key);
  });

  it('answers plain lines for the installer', async () => {
    const { app, code } = await connected(['claude', 'codex']);
    const res = await join(app, code, {}, { accept: 'text/plain' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^[0-9a-f-]{36} (claude|codex) [A-Za-z0-9_-]{43}$/);
  });

  it('refuses a used, an expired and an unknown code', async () => {
    const { app, db, code } = await connected(['claude']);
    expect((await join(app, code)).statusCode).toBe(200);
    const again = await join(app, code);
    expect(again.statusCode).toBe(410);
    expect(again.json().error.reason).toBe('code_used');

    const fresh = await connected(['kimi']);
    await fresh.db.update(nodeCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await join(fresh.app, fresh.code);
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.reason).toBe('code_used');

    const unknown = await join(app, 'A'.repeat(43));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.reason).toBe('code_unknown');
    void db;
  });

  it('checks the machine details', async () => {
    const { app, code } = await connected(['claude']);
    for (const bad of [{ machineId: 'x' }, { os: 'windows' }, { arch: 'ppc' }, { hostname: '' }]) {
      expect((await join(app, code, bad)).statusCode).toBe(400);
    }
  });

  it('reuses the machine for a second code from the same computer', async () => {
    const { app, ceo, code } = await connected(['claude']);
    await join(app, code);
    const second = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['glm'] }, ...as(ceo) });
    expect((await join(app, codeOf(second.json().command))).statusCode).toBe(200);
    const list = await machinesOf(app, ceo);
    expect(list).toHaveLength(1);
    expect(list[0].plans).toHaveLength(2);
  });

  it('skips subscriptions that already joined a machine, and says the code is used when nothing is left', async () => {
    const { app, db, code } = await connected(['claude']);
    const extra = await legacyCopy(db, code);
    await join(app, code);
    const late = await join(app, extra, { machineId: 'other-machine-01', hostname: 'dev-laptop' });
    expect(late.statusCode).toBe(410);
    expect(late.json().error.reason).toBe('code_used');
  });

  it('puts a plan on one machine only when two commands for it join at once', async () => {
    const { app, db, code, ids } = await connected(['claude']);
    const extra = await legacyCopy(db, code);
    const both = await Promise.all([join(app, code), join(app, extra, { machineId: 'other-machine-01', hostname: 'dev-laptop' })]);
    expect(both.map(r => r.statusCode).sort()).toEqual([200, 410]);
    expect(await db.select().from(nodes).where(eq(nodes.subscriptionId, ids[0]!))).toHaveLength(1);
  });

  it('closes the old node socket on plan reconnect or re-join and rejects messages from a revoked key so it never receives replacement jobs or tool tokens', async () => {
    const { app, db, ceo, code, ids } = await connected(['codex']);
    const url = await listen(app);
    const subId = ids[0]!;
    const first = (await join(app, code, { machineId: 'mac-0001-abcd', hostname: 'machine-a' })).json().nodes[0];
    const oldSocket = await connectNode(url, first.key);

    const reconnected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(ceo) })).json();
    await receiveNodeMessage(app.ctx, { kind: 'node', nodeId: first.nodeId, keyHash: hashToken(first.key) }, { type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await receiveNodeMessage(app.ctx, BUILTIN, { type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    const second = (await join(app, codeOf(reconnected.command), { machineId: 'mac-0002-efgh', hostname: 'machine-b' })).json().nodes[0];
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.key).not.toBe(first.key);

    oldSocket.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await receiveNodeMessage(app.ctx, { kind: 'node', nodeId: first.nodeId, keyHash: hashToken(first.key) }, { type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await receiveNodeMessage(app.ctx, { kind: 'node', nodeId: first.nodeId, keyHash: hashToken(first.key) }, { type: 'status', loggedIn: true, limits: null });
    expect((await db.select().from(nodes).where(eq(nodes.id, second.nodeId)))[0]).toMatchObject({ status: 'needs_login', keyHash: hashToken(second.key) });
    expect(await oldSocket.closed).toBe(4001);

    const [company] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: company!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const [bruno] = await db
      .insert(agents)
      .values({ companyId: company!.id, kind: 'worker', name: 'Bruno', roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: subId })
      .returning();
    const refused = await app.inject({ method: 'POST', url: `/api/agents/${bruno!.id}/messages`, payload: { text: 'Hello Bruno' }, ...as(ceo) });
    expect(refused.statusCode).toBe(409);
    expect(oldSocket.queued()).toBe(0);

    const newSocket = await connectNode(url, second.key);
    const boot = { startedAt: '2026-11-03T20:00:00.000Z', machineUpAt: '2026-11-01T00:00:00.000Z', container: 'new-container' };
    newSocket.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], boot });
    await until(async () => (await db.select().from(nodes).where(eq(nodes.id, second.nodeId)))[0]!.status === 'ready');
    await receiveNodeMessage(
      app.ctx,
      { kind: 'node', nodeId: second.nodeId, keyHash: hashToken(first.key) },
      { type: 'node.stopping', startedAt: boot.startedAt, exit: { kind: 'planned', reason: 'node_update', startedAt: boot.startedAt, at: '2026-11-03T20:59:59.000Z', log: 'stop' } },
    );
    expect((await db.select().from(nodes).where(eq(nodes.id, second.nodeId)))[0]!.boot).toEqual(boot);
    await receiveNodeMessage(
      app.ctx,
      { kind: 'node', nodeId: second.nodeId, keyHash: hashToken(second.key) },
      { type: 'node.stopping', startedAt: boot.startedAt, exit: { kind: 'planned', reason: 'node_update', startedAt: boot.startedAt, at: '2026-11-03T20:59:59.000Z', log: 'stop' } },
    );
    expect((await db.select().from(nodes).where(eq(nodes.id, second.nodeId)))[0]!.boot).toMatchObject({ ...boot, stopped: expect.objectContaining({ kind: 'planned' }) });
    await receiveNodeMessage(app.ctx, { kind: 'node', nodeId: second.nodeId }, { type: 'status', loggedIn: true, limits: null });
    const sent = await app.inject({ method: 'POST', url: `/api/agents/${bruno!.id}/messages`, payload: { text: 'Hello Bruno' }, ...as(ceo) });
    expect(sent.statusCode).toBe(202);
    const Dispatched = await newSocket.next();
    expect(Dispatched).toMatchObject({ type: 'job.run', toolToken: expect.any(String) });
    expect(oldSocket.queued()).toBe(0);

    /* Removing the subscription, reconnecting it and joining again also closes the previous socket and revokes its key. */
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${subId}`, ...as(ceo) })).statusCode).toBe(204);
    expect(await newSocket.next()).toEqual({ type: 'remove' });
    const thirdConnect = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(ceo) })).json();
    expect(await newSocket.closed).toBe(4001);
    const thirdJoin = (await join(app, codeOf(thirdConnect.command), { machineId: 'mac-0001-abcd', hostname: 'machine-a' })).json();
    const third = thirdJoin.nodes[0];
    await receiveNodeMessage(app.ctx, { kind: 'node', nodeId: third.nodeId, keyHash: hashToken(second.key) }, { type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    expect((await db.select().from(nodes).where(eq(nodes.id, third.nodeId)))[0]).toMatchObject({ status: 'needs_login', keyHash: hashToken(third.key) });

    /* Disconnecting the machine and re-joining on the same machine re-keys the same node row and rejects the old key. */
    const thirdSocket = await connectNode(url, third.key);
    expect((await app.inject({ method: 'POST', url: `/api/machines/${thirdJoin.machine.id}/disconnect`, ...as(ceo) })).statusCode).toBe(204);
    expect(await thirdSocket.closed).toBe(4001);
    const fourthCmd = (await app.inject({ method: 'POST', url: `/api/subscriptions/${subId}/command`, ...as(ceo) })).json();
    const fourth = (await join(app, codeOf(fourthCmd.command), { machineId: 'mac-0001-abcd', hostname: 'machine-a' })).json().nodes[0];
    expect(fourth.nodeId).toBe(third.nodeId);
    await receiveNodeMessage(app.ctx, { kind: 'node', nodeId: fourth.nodeId, keyHash: hashToken(third.key) }, { type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    expect((await db.select().from(nodes).where(eq(nodes.id, fourth.nodeId)))[0]).toMatchObject({ status: 'needs_login', keyHash: hashToken(fourth.key) });
  });
});

describe('a machine without a plan', () => {
  const machineCommand = async (app: FastifyInstance, token: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) });
    expect(res.statusCode).toBe(201);
    return codeOf(res.json().command);
  };

  it('joins with a command of its own and gets a node of its own, which no plan needs', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const res = await join(app, await machineCommand(app, ceo), {}, { accept: 'text/plain' });
    expect(res.statusCode).toBe(200);
    const [line] = res.body.trim().split('\n');
    expect(res.body.trim().split('\n')).toHaveLength(1);
    const [nodeId, word, key] = line!.split(' ');
    expect(word).toBe('machine');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId!));
    expect(node).toMatchObject({ subscriptionId: null });
    expect(await machinesOf(app, ceo)).toMatchObject([{ id: node!.machineId, hostname: 'dev-mac', owner: { name: 'Ivan' }, online: false, plans: [] }]);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.kind, 'personal'))).toEqual([]);
  });

  it('shows keeper contact on both screens independently of the subscription socket', async () => {
    const { app, db, ceo, code, ids } = await connected(['antigravity']);
    const { machine } = (await join(app, code)).json();
    const now = new Date();
    const stale = new Date(now.getTime() - 600_000);
    await db.update(nodes).set({ lastSeenAt: stale }).where(eq(nodes.machineId, machine.id));
    const check = async (reportAt: Date | null, online: boolean, last: Date) => {
      await db.update(machines).set({ networkId: hashToken('synthetic-keeper'), role: 'worker', reportAt }).where(eq(machines.id, machine.id));
      const card = (await machinesOf(app, ceo)).find((m: { id: string }) => m.id === machine.id);
      const views = (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions;
      const sub = views.find((p: { id: string }) => p.id === ids[0]);
      expect(card).toMatchObject({ online, lastSeenAt: last.toISOString() });
      expect(sub).toMatchObject({ online: false, machines: [expect.objectContaining({ id: machine.id, online: false, hostOnline: online, hostLastSeenAt: last.toISOString() })] });
    };
    await check(now, true, now);
    await check(new Date(stale.getTime() - 1000), false, stale);
    await check(null, false, stale);
    await db.update(nodes).set({ lastSeenAt: null }).where(eq(nodes.machineId, machine.id));
    const unknown = (await machinesOf(app, ceo)).find((m: { id: string }) => m.id === machine.id);
    expect(unknown).toMatchObject({ online: false, lastSeenAt: null });
  });

  it('recognizes the local built-in socket on a legacy host with no keeper id', async () => {
    const key = 'k'.repeat(40);
    const { app, ceo, code, ids } = await connected(['codex'], { NODE_KEY: key, HORNHOOF_HOST_ID: hashToken(`hornhoof-host:${MACHINE.machineId}`) });
    const { machine } = (await join(app, code)).json();
    const builtin = await connectNode(await listen(app), key);
    builtin.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await until(async () => (await machinesOf(app, ceo)).find((m: { id: string }) => m.id === machine.id)?.online);
    const views = (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions;
    expect(views.find((s: { id: string }) => s.id === ids[0])).toMatchObject({ online: false, machines: [expect.objectContaining({ hostOnline: true })] });
    builtin.close();
    await builtin.closed;
  });

  it('counts a connected sibling as host contact without making another plan ready', async () => {
    const { app, ceo, code, ids } = await connected(['codex', 'claude']);
    const { machine, nodes: joined } = (await join(app, code)).json();
    const key = joined.find((n: { subscriptionId: string }) => n.subscriptionId === ids[0]).key;
    const url = await listen(app);
    const first = await connectNode(url, key);
    first.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    const plans = async () => (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions;
    const plan = async (id: string) => (await plans()).find((s: { id: string }) => s.id === id);
    await until(async () => (await plan(ids[0]!)).status === 'ready');
    const replacement = await connectNode(url, key);
    replacement.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await first.closed;
    await until(async () => (await plan(ids[0]!)).status === 'ready');
    expect(await plan(ids[0]!)).toMatchObject({ online: true, status: 'ready' });
    expect(await plan(ids[1]!)).toMatchObject({ online: false, machines: [expect.objectContaining({ id: machine.id, online: false, hostOnline: true })] });
    replacement.close();
    await replacement.closed;
  });

  it('shows the machine online while its node is connected, and disconnects it as any other', async () => {
    const { app, db } = await testApp();
    const url = await listen(app);
    const ceo = await setUpCompany(app);
    const { machine, nodes: made } = (await join(app, await machineCommand(app, ceo))).json();
    expect(made).toMatchObject([{ subscriptionId: null, provider: 'machine' }]);
    const node = await connectNode(url, made[0].key);
    node.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await until(async () => (await db.select().from(nodes).where(eq(nodes.id, made[0].nodeId)))[0]!.version === '0.9.0');
    expect((await db.select().from(nodes).where(eq(nodes.id, made[0].nodeId)))[0]).toMatchObject({ status: 'ready' });
    expect((await machinesOf(app, ceo))[0].online).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/machines/${machine.id}/disconnect`, ...as(ceo) })).statusCode).toBe(204);
    expect(await node.closed).toBe(4001);
    expect(await machinesOf(app, ceo)).toEqual([]);
  });

  it('never gives its node a new key while it has one, so a second command cannot take the machine over', async () => {
    const { app, db } = await testApp();
    const url = await listen(app);
    const ceo = await setUpCompany(app);
    const first = (await join(app, await machineCommand(app, ceo))).json();
    const duplicateCode = await machineCommand(app, ceo);
    const again = await join(app, duplicateCode);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('already_on_machine');
    await app.inject({ method: 'POST', url: `/api/nodes/commands/${hashToken(duplicateCode)}/hide`, ...as(ceo) });
    const node = await connectNode(url, first.nodes[0].key);
    node.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    await until(async () => (await machinesOf(app, ceo))[0].online === true);
    await app.inject({ method: 'POST', url: `/api/machines/${first.machine.id}/disconnect`, ...as(ceo) });
    const back = (await join(app, await machineCommand(app, ceo))).json();
    expect(back.nodes[0].nodeId).toBe(first.nodes[0].nodeId);
    expect(await db.select().from(nodes)).toHaveLength(1);
  });

  it('is made by anyone in the company for their own machine', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const [company] = await db.select().from(companies);
    const [dept] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'CSO' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [dept!.id] } });
    expect((await join(app, await machineCommand(app, maria))).statusCode).toBe(200);
    expect(await machinesOf(app, maria)).toMatchObject([{ owner: { name: 'Maria' }, plans: [] }]);
    expect((await app.inject({ method: 'POST', url: '/api/machines/command' })).statusCode).toBe(401);
  });
});

describe('one plan on several machines', () => {
  const LAPTOP = { machineId: 'laptop-0002-abcd', hostname: 'dev-laptop' };
  const machineCode = async (app: FastifyInstance, token: string) => codeOf((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command);
  const addPlan = (app: FastifyInstance, token: string, machineId: string, subscription: string) =>
    app.inject({ method: 'POST', url: `/api/machines/${machineId}/plans`, payload: { subscription }, ...as(token) });

  /* Ivan's Claude plan on his Mac, and his laptop joined without a plan. */
  async function twoMachines(env: NodeJS.ProcessEnv = {}) {
    const { app, db, ceo, code, ids } = await connected(['claude'], env);
    const mac = (await join(app, code)).json();
    const laptop = (await join(app, await machineCode(app, ceo), LAPTOP)).json();
    return { app, db, ceo, plan: ids[0]!, mac, laptop };
  }

  it("adds the owner's plan to another machine of theirs, where it signs in by itself, and keeps it on the first", async () => {
    const { app, db, ceo, plan, mac, laptop } = await twoMachines();
    const res = await addPlan(app, ceo, laptop.machine.id, plan);
    expect(res.statusCode).toBe(201);
    const added = await join(app, codeOf(res.json().command), LAPTOP, { accept: 'text/plain' });
    expect(added.statusCode).toBe(200);
    const [nodeId, provider] = added.body.trim().split(' ');
    expect(provider).toBe('claude');
    expect(nodeId).not.toBe(mac.nodes[0].nodeId);
    const rows = await db.select().from(nodes).where(eq(nodes.subscriptionId, plan));
    expect(rows.map(n => n.machineId).sort()).toEqual([mac.machine.id, laptop.machine.id].sort());
    expect(new Set(rows.map(n => n.keyHash)).size).toBe(2);
    expect((await db.select().from(nodes).where(eq(nodes.id, nodeId!)))[0]).toMatchObject({ status: 'needs_login' });
    expect(await machinesOf(app, ceo)).toMatchObject([{ hostname: 'dev-mac', plans: [{ id: plan }] }, { hostname: 'dev-laptop', plans: [{ id: plan }] }]);
  });

  it('works only on the machine it was made for, and stays unused there', async () => {
    const { app, ceo, plan, laptop } = await twoMachines();
    const code = codeOf((await addPlan(app, ceo, laptop.machine.id, plan)).json().command);
    const elsewhere = await join(app, code, { machineId: 'tower-0003-abcd', hostname: 'dev-tower' });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().error).toMatchObject({ reason: 'other_machine', message: expect.stringContaining('dev-laptop') });
    expect((await join(app, code, LAPTOP)).statusCode).toBe(200);
  });

  it("takes only the machine's owner and their own plan, once per machine", async () => {
    const { app, db, ceo, plan, mac, laptop } = await twoMachines();
    const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    const olegs = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(oleg) })).json();
    const tower = (await join(app, codeOf(olegs.command), { machineId: 'tower-0003-abcd', hostname: 'oleg-tower' })).json();

    const notTheirs = await addPlan(app, oleg, laptop.machine.id, olegs.subscriptions[0].id);
    expect(notTheirs.statusCode).toBe(403);
    expect(notTheirs.json().error.reason).toBe('not_owner');
    const notMine = await addPlan(app, ceo, laptop.machine.id, olegs.subscriptions[0].id);
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json().error.reason).toBe('not_owner');
    const onIt = await addPlan(app, ceo, mac.machine.id, plan);
    expect(onIt.statusCode).toBe(409);
    expect(onIt.json().error.reason).toBe('already_on_machine');
    expect((await addPlan(app, ceo, '00000000-0000-4000-8000-000000000000', plan)).statusCode).toBe(404);
    expect((await addPlan(app, ceo, laptop.machine.id, '00000000-0000-4000-8000-000000000000')).json().error.reason).toBe('subscription_unknown');
    await db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, plan));
    expect((await addPlan(app, ceo, laptop.machine.id, plan)).json().error.reason).toBe('subscription_unknown');
    void tower;
  });

  it('lists every machine of a plan with its state there, and every plan of a machine', async () => {
    const { app, ceo, plan, mac, laptop } = await twoMachines();
    const url = await listen(app);
    const onLaptop = (await join(app, codeOf((await addPlan(app, ceo, laptop.machine.id, plan)).json().command), LAPTOP)).json().nodes[0];
    const node = await connectNode(url, onLaptop.key);
    node.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    const sub = async () => (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.find((s: { id: string }) => s.id === plan);
    await until(async () => (await sub()).status === 'ready');
    expect((await sub()).machines).toEqual([
      { id: mac.machine.id, hostname: 'dev-mac', status: 'needs_login', online: false, hostOnline: false, hostLastSeenAt: null },
      { id: laptop.machine.id, hostname: 'dev-laptop', status: 'ready', online: true, hostOnline: true, hostLastSeenAt: expect.any(String) },
    ]);
    const tower = (await join(app, await machineCode(app, ceo), { machineId: 'tower-0003-abcd', hostname: 'dev-tower' })).json();
    expect(await machinesOf(app, ceo)).toMatchObject([
      { id: mac.machine.id, plans: [{ id: plan, provider: 'claude', status: 'needs_login', online: false }] },
      { id: laptop.machine.id, plans: [{ id: plan, provider: 'claude', status: 'ready', online: true }] },
      { id: tower.machine.id, plans: [] },
    ]);
  });

  it('says what runs on each machine now: the employees whose program is there, and the parts of test runs', async () => {
    const { app, db, ceo, plan, mac, laptop } = await twoMachines();
    const [acme] = await db.select().from(companies);
    const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV' }).returning();
    const hire = async (name: string) =>
      (await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name, roleKey: 'DEV-BE', departmentId: dev!.id, model: '', subscriptionId: plan, nodeId: mac.nodes[0].nodeId }).returning())[0]!;
    const bruno = await hire('Bruno');
    const vera = await hire('Vera');
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: plan, agentId: bruno.id, prompt: 'work', status: 'running', timeoutMs: 1000, startedAt: new Date() }).returning();
    const [task] = await db.insert(tasks).values({ companyId: acme!.id, number: 12, title: 'Checkout API', assigneeAgentId: bruno.id }).returning();
    await db.update(jobs).set({ taskId: task!.id }).where(eq(jobs.id, job!.id));
    const [run] = await db.insert(testRuns).values({ companyId: acme!.id, number: 3, taskId: task!.id, agentId: bruno.id, jobId: job!.id, command: 'npm test', parts: 2, timeoutMs: 60_000 }).returning();
    const startedAt = new Date('2026-11-01T10:00:00Z');
    await db.insert(testParts).values([
      { companyId: acme!.id, runId: run!.id, part: 1, status: 'running', machineId: laptop.machine.id, startedAt },
      { companyId: acme!.id, runId: run!.id, part: 2, status: 'passed', machineId: laptop.machine.id, startedAt },
    ]);
    expect(await machinesOf(app, ceo)).toMatchObject([
      {
        id: mac.machine.id,
        running: {
          agents: [
            { id: bruno.id, name: 'Bruno', busy: true, title: { en: 'Backend engineer', ru: 'Бэкенд-разработчик' }, department: { id: dev!.id, name: 'Development' }, provider: 'claude', since: job!.startedAt!.toISOString(), task: { number: 12, title: 'Checkout API' }, withCeo: false },
            { id: vera.id, name: 'Vera', busy: false, department: { id: dev!.id, name: 'Development' }, provider: 'claude', since: null, task: null, withCeo: false },
          ],
          parts: [],
        },
      },
      { id: laptop.machine.id, running: { agents: [], parts: [{ run: 3, kind: 'tests', task: 12, part: 1, parts: 2, agent: 'Bruno', startedAt: startedAt.toISOString() }] } },
    ]);
    await db.update(testParts).set({ machineId: null, builtin: true }).where(eq(testParts.part, 1));
    expect((await app.inject({ url: '/api/machines', ...as(ceo) })).json().builtin.running.parts).toMatchObject([{ run: 3, part: 1 }]);
  });

  it('keeps map order across personal plans and keys when both run on the server machine', async () => {
    const { app, db, ceo, plan, mac } = await twoMachines({ HORNHOOF_HOST_ID: hashToken(`hornhoof-host:${MACHINE.machineId}`) });
    const [company] = await db.select().from(companies);
    const [key] = await db.select().from(subscriptions).where(eq(subscriptions.kind, 'api_key'));
    const [first, second] = await db.insert(departments).values([
      { companyId: company!.id, name: 'Operations', roleCode: 'OPS', position: 0 },
      { companyId: company!.id, name: 'Development', roleCode: 'DEV', position: 1 },
    ]).returning();
    await db.insert(agents).values([
      { companyId: company!.id, name: 'Zoe', kind: 'worker', model: '', departmentId: first!.id, subscriptionId: key!.id },
      { companyId: company!.id, name: 'Anna', kind: 'worker', model: '', departmentId: second!.id, subscriptionId: plan, nodeId: mac.nodes[0].nodeId },
    ]);
    const shown = (await machinesOf(app, ceo)).find((m: { id: string }) => m.id === mac.machine.id);
    expect(shown.running.agents.map((a: { name: string }) => a.name)).toEqual(['Orchestrator', 'Zoe', 'Anna']);
  });

  it('never gives a plan a new key on a machine it runs on, so a second command cannot take its node over', async () => {
    const { app, db, ceo, plan, laptop } = await twoMachines();
    const one = codeOf((await addPlan(app, ceo, laptop.machine.id, plan)).json().command);
    const two = await legacyCopy(db, one);
    const added = (await join(app, one, LAPTOP)).json().nodes[0];
    const again = await join(app, two, LAPTOP);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('already_on_machine');
    const [node] = await db.select().from(nodes).where(eq(nodes.id, added.nodeId));
    expect(node!.keyHash).toBe(hashToken(added.key));
  });

  it('keeps the plan ready while one of its machines is signed in, and waiting once none is left', async () => {
    const { app, db, ceo, plan, mac, laptop } = await twoMachines();
    const url = await listen(app);
    const onLaptop = (await join(app, codeOf((await addPlan(app, ceo, laptop.machine.id, plan)).json().command), LAPTOP)).json().nodes[0];
    const status = async () => (await db.select().from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.status;
    const signedIn = await connectNode(url, mac.nodes[0].key);
    signedIn.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    const signedOut = await connectNode(url, onLaptop.key);
    signedOut.send({ type: 'hello', version: '0.9.0', loggedIn: false, running: [] });
    await until(async () => (await db.select().from(nodes).where(eq(nodes.id, onLaptop.nodeId)))[0]!.version === '0.9.0');
    await until(async () => (await status()) === 'ready');
    await app.inject({ method: 'POST', url: `/api/machines/${mac.machine.id}/disconnect`, ...as(ceo) });
    expect(await status()).toBe('needs_login');
    expect((await db.select().from(nodes).where(eq(nodes.id, mac.nodes[0].nodeId)))[0]!.status).toBe('needs_login');
    await app.inject({ method: 'POST', url: `/api/machines/${laptop.machine.id}/disconnect`, ...as(ceo) });
    expect(await status()).toBe('waiting_machine');
  });

  it('shows the plan ready and online only when one machine of it is both, and otherwise as the machine that is online', async () => {
    const { app, ceo, plan, mac, laptop } = await twoMachines();
    const url = await listen(app);
    const onLaptop = (await join(app, codeOf((await addPlan(app, ceo, laptop.machine.id, plan)).json().command), LAPTOP)).json().nodes[0];
    const shown = async () => (await app.inject({ url: '/api/subscriptions', ...as(ceo) })).json().subscriptions.find((s: { id: string }) => s.id === plan);
    const signedIn = await connectNode(url, mac.nodes[0].key);
    signedIn.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [] });
    const signedOut = await connectNode(url, onLaptop.key);
    signedOut.send({ type: 'hello', version: '0.9.0', loggedIn: false, running: [] });
    await until(async () => (await shown()).status === 'ready');
    expect(await shown()).toMatchObject({ status: 'ready', online: true });
    signedIn.close();
    await signedIn.closed;
    await until(async () => (await shown()).machines.every((m: { online: boolean; status: string }) => m.online === (m.status === 'needs_login')));
    expect(await shown()).toMatchObject({ status: 'needs_login', online: true });
    signedOut.close();
    await signedOut.closed;
    await until(async () => !(await shown()).online);
    expect((await shown()).status).toBe('ready');
  });
});

describe('POST /api/machines/:id/disconnect', () => {
  it('sends the subscriptions back to waiting and hides the machine', async () => {
    const { app, db, ceo, code, ids } = await connected(['claude', 'codex']);
    const { machine } = (await join(app, code)).json();
    const [company] = await db.select().from(companies);
    const [dept] = await db.insert(departments).values({ companyId: company!.id, name: 'Sales', roleCode: 'CSO' }).returning();
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { departments: [dept!.id] } });

    const refused = await app.inject({ method: 'POST', url: `/api/machines/${machine.id}/disconnect`, ...as(maria) });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('not_owner');
    expect(await machinesOf(app, maria)).toEqual([]);

    const res = await app.inject({ method: 'POST', url: `/api/machines/${machine.id}/disconnect`, ...as(ceo) });
    expect(res.statusCode).toBe(204);
    for (const id of ids) {
      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
      expect(row).toMatchObject({ status: 'waiting_machine' });
      expect(await db.select().from(nodes).where(eq(nodes.subscriptionId, id))).toMatchObject([{ keyHash: null }]);
    }
    expect(await machinesOf(app, ceo)).toEqual([]);
  });

  it("disconnects a disabled person's machines, frees the orchestrator and refuses their unused code", async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    const connect = (providers: string[]) => app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(oleg) });
    const first = (await connect(['claude'])).json();
    const subId = first.subscriptions[0].id;
    expect((await join(app, codeOf(first.command))).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${subId}/orchestrator`, ...as(ceo) })).statusCode).toBe(200);
    const spare = codeOf((await connect(['codex'])).json().command);

    const [person] = await db.select().from(people).where(eq(people.email, 'oleg@acme.com'));
    expect((await app.inject({ method: 'PATCH', url: `/api/people/${person!.id}`, payload: { status: 'disabled' }, ...as(ceo) })).statusCode).toBe(200);

    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, subId));
    expect(row).toMatchObject({ status: 'waiting_machine' });
    expect(await db.select().from(nodes).where(eq(nodes.subscriptionId, subId))).toMatchObject([{ keyHash: null }]);
    expect(await machinesOf(app, ceo)).toEqual([]);
    const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect(orchestrator!.subscriptionId).toBeNull();
    expect((await join(app, spare, { machineId: 'mac-0002-abcd' })).statusCode).toBe(410);
  });

  it('knows the priority route', async () => {
    const { app, db, ceo } = await connected(['claude']);
    const put = (id: string) => app.inject({ method: 'PUT', url: `/api/machines/${id}/priority`, payload: { pin: null }, ...as(ceo) });
    const unknown = await put('00000000-0000-4000-8000-000000000000');
    expect([unknown.statusCode, unknown.json().error.reason]).toEqual([404, 'machine_unknown']);
    /* The row of the machine the server itself runs on is no machine people act on. */
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [own] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'server:0f0f', networkId: '0f'.repeat(16), role: 'data' }).returning();
    const server = await put(own!.id);
    expect([server.statusCode, server.json().error.reason]).toEqual([404, 'machine_unknown']);
  });

  it('says when the machine does not exist', async () => {
    const { app, ceo } = await connected(['claude']);
    const res = await app.inject({ method: 'POST', url: '/api/machines/00000000-0000-4000-8000-000000000000/disconnect', ...as(ceo) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.reason).toBe('machine_unknown');
  });
});

describe('GET /install.sh', () => {
  it('serves the installer with this server address filled in', async () => {
    const { app } = await testApp();
    const res = await app.inject({ url: '/install.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain('http://localhost:8080');
    expect(res.body).not.toContain('__HORNHOOF_SERVER__');
    expect(res.body).not.toContain('__HORNHOOF_NODE_IMAGE__');
  });
});

describe('node config', () => {
  it('refuses a short NODE_KEY and reads the ping interval', async () => {
    await expect(testApp({ NODE_KEY: 'short' })).rejects.toThrow(/NODE_KEY/);
    const { config } = await testApp({ NODE_KEY: 'k'.repeat(32), NODE_PING_MS: '500' });
    expect(config.nodeKey).toBe('k'.repeat(32));
    expect(config.nodePingMs).toBe(500);
  });
});

describe('active commands for the person who made them', () => {
  it('keeps commands encrypted and owner-only, dismisses plan blocks and invalidates cancelled machine codes', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const commandsOf = async (token: string) =>
      (await app.inject({ url: '/api/nodes/commands', ...as(token) })).json().commands as {
        id: string;
        kind: 'plans' | 'machine' | 'add';
        plans: string[];
        machineId: string | null;
        machine: string | null;
        command: string;
        expiresAt: string;
      }[];

    const firstPlan = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    const subId = firstPlan.subscriptions[0].id as string;
    const planCmd = firstPlan;
    const firstMachine = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json();
    const joined = (await join(app, codeOf(firstMachine.command))).json();
    const machineCmd = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json();
    const addCmd = (await app.inject({ method: 'POST', url: `/api/machines/${joined.machine.id}/plans`, payload: { subscription: subId }, ...as(ceo) })).json();

    for (const made of [firstPlan, planCmd, machineCmd, addCmd]) {
      expect(made).toMatchObject({ id: hashToken(codeOf(made.command)), command: expect.any(String), expiresAt: expect.any(String) });
    }

    const stored = JSON.stringify(await db.select().from(nodeCodes));
    for (const made of [firstPlan, planCmd, machineCmd, addCmd]) {
      expect(stored).not.toContain(codeOf(made.command));
      expect(stored).not.toContain(made.command);
    }

    const active = await commandsOf(ceo);
    expect(active).toEqual([
      { id: planCmd.id, kind: 'plans', plans: ['Claude'], machineId: null, machine: null, command: planCmd.command, expiresAt: planCmd.expiresAt, subscriptionIds: [subId], dismissedSubscriptionIds: [] },
      { id: machineCmd.id, kind: 'machine', plans: [], machineId: null, machine: null, command: machineCmd.command, expiresAt: machineCmd.expiresAt, subscriptionIds: [], dismissedSubscriptionIds: [] },
      { id: addCmd.id, kind: 'add', plans: ['Claude'], machineId: joined.machine.id, machine: 'dev-mac', command: addCmd.command, expiresAt: addCmd.expiresAt, subscriptionIds: [subId], dismissedSubscriptionIds: [] },
    ]);

    expect(await commandsOf(maria)).toEqual([]);
    const mariaPlan = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['kimi'] }, ...as(maria) })).json();
    expect((await commandsOf(maria)).map(c => c.id)).toEqual([mariaPlan.id]);
    expect((await commandsOf(ceo)).map(c => c.id)).toEqual([planCmd.id, machineCmd.id, addCmd.id]);

    await db.update(nodeCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(nodeCodes.codeHash, mariaPlan.id));
    expect(await commandsOf(maria)).toEqual([]);

    for (const made of [planCmd, machineCmd, addCmd]) {
      expect((await app.inject({ method: 'POST', url: `/api/nodes/commands/${made.id}/hide`, ...as(ceo) })).statusCode).toBe(204);
      const attempt = await join(app, codeOf(made.command), made === addCmd ? {} : { machineId: 'other-mac-9999', hostname: 'other' });
      expect(attempt.statusCode).toBe(made === planCmd ? 200 : 410);
      if (made !== planCmd) expect(attempt.json().error.reason).toBe('code_used');
    }
    expect(await commandsOf(ceo)).toEqual([]);
  });
});

describe("each machine's place in the company's network", () => {
  const HOST_KEY = 'host-0000-abcd';
  const HOST_ID = hashToken(`hornhoof-host:${HOST_KEY}`);
  const DAY = 86_400_000;
  type Shown = { id: string; hostname: string; core: { webPort: number | null; path: string | null } | null; needsCore: boolean };
  type Listed = { machines: Shown[]; builtin: { machine: { id: string; hostname: string } | null; webPort: number | null; refusedBy: string[] } };
  const listed = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json() as Listed;
  const machineCommand = async (app: FastifyInstance, token: string) => codeOf((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command);

  it("shows each machine's core and the server's, and who still needs one", async () => {
    const { app, db } = await testApp({ HORNHOOF_MACHINE_ID: HOST_ID });
    const ceo = await setUpCompany(app);
    const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.com', access: { whole: true } });
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const mac = (await join(app, await machineCommand(app, ceo))).json().machine.id as string;
    const laptop = (await join(app, await machineCommand(app, ceo), { machineId: 'laptop-0002-abcd', hostname: 'dev-laptop' })).json().machine.id as string;
    /* The Mac became a worker and reported through the relay, a while ago; the laptop has its node and no core. */
    await db.update(machines).set({ networkId: hashToken('mac'), role: 'worker', webPort: 8081, path: 'relay', directFails: true, reportAt: new Date(Date.now() - 2 * DAY) }).where(eq(machines.id, mac));
    await db.update(nodes).set({ lastSeenAt: new Date(Date.now() - 3_600_000) }).where(eq(nodes.machineId, laptop));
    /* The server's own row, as its keeper reported it. */
    await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: `server:${HOST_ID}`, networkId: HOST_ID, role: 'data', webPort: 8080 });

    const mine = await listed(app, ceo);
    const byId = (list: Listed, id: string) => list.machines.find(machine => machine.id === id)!;
    expect(byId(mine, mac)).toMatchObject({ core: { webPort: 8081, path: 'relay' }, needsCore: false });
    expect(byId(mine, laptop)).toMatchObject({ core: null, needsCore: true });
    /* What a machine said days ago of the way to the server is no news of today. */
    expect(mine.builtin).toMatchObject({ webPort: 8080, refusedBy: [] });
    await db.update(machines).set({ reportAt: new Date() }).where(eq(machines.id, mac));
    expect((await listed(app, ceo)).builtin).toMatchObject({ webPort: 8080, refusedBy: ['dev-mac'] });
    /* Only the machine's owner is offered the core for it. */
    expect(byId(await listed(app, maria), laptop)).toMatchObject({ core: null, needsCore: false });
    /* A machine whose nodes were last seen days ago is not asked to do anything. */
    await db.update(nodes).set({ lastSeenAt: new Date(Date.now() - 2 * DAY) }).where(eq(nodes.machineId, laptop));
    expect(byId(await listed(app, ceo), laptop).needsCore).toBe(false);
    /* A worker that was disconnected refuses nobody any more. */
    await db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, mac));
    expect((await listed(app, ceo)).builtin.refusedBy).toEqual([]);
  });

  it('shows the order and the copies to those who see the whole company', async () => {
    const { app, db } = await testApp({ HORNHOOF_MACHINE_ID: HOST_ID });
    const ceo = await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'CSO' }).returning();
    const anna = await invitePerson(app, ceo, { name: 'Anna', email: 'anna@acme.com', access: { departments: [sales!.id] } });
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const host = (await join(app, await machineCommand(app, ceo), { machineId: HOST_KEY, hostname: 'server-box' })).json().machine.id as string;
    const mac = (await join(app, await machineCommand(app, ceo))).json().machine.id as string;
    const hers = (await join(app, await machineCommand(app, anna), { machineId: 'anna-0003-abcd', hostname: 'anna-pc' })).json().machine.id as string;
    await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: `server:${HOST_ID}`, hostname: 'server-box', networkId: HOST_ID, role: 'data', serverOrder: 1, serverWhy: 'server' });
    await db.update(machines).set({ networkId: hashToken('mac'), role: 'data', serverOrder: 2, copyState: 'making', copyProgress: 40, copyName: 'copy_0f0f0f0f0f0f0f0f_1' }).where(eq(machines.id, mac));
    await db.update(machines).set({ networkId: hashToken('anna-pc'), role: 'worker' }).where(eq(machines.id, hers));
    type Data = { number: number | null; why: string | null; unfit: { why: string; person?: string } | null; copy: { line: string; progress?: number } | null; leftAt: string | null };
    type Held = { priority: boolean; machines: { id: string; data?: Data | null }[]; copies?: { leader: string; copies: { hostname: string; sync: boolean }[]; onlySince: string | null } | null };
    const held = async (token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json() as Held;
    const mine = await held(ceo);
    const of = (list: Held, id: string) => list.machines.find(machine => machine.id === id)!;
    expect(of(mine, mac).data).toEqual({ number: 2, why: null, pin: null, unfit: null, copy: { line: 'making', progress: 40 }, leftAt: null, led: null });
    /* The card of the computer the server itself runs on says what the server's own row says. */
    expect(of(mine, host).data).toMatchObject({ number: 1, why: 'server', unfit: null, copy: null });
    /* A machine of someone who does not see the whole company holds no copy, and its card says why. */
    expect(of(mine, hers).data).toMatchObject({ number: null, unfit: { why: 'scope', person: 'Anna' } });
    expect(mine.copies).toEqual({ leader: 'server-box', copies: [{ hostname: 'dev-mac', sync: false }], onlySince: null });
    /* She sees her own machine, and nothing of who holds the company's data. */
    const theirs = await held(anna);
    expect(theirs.machines.map(machine => machine.id)).toEqual([hers]);
    expect(theirs.machines[0]).not.toHaveProperty('data');
    expect(theirs).not.toHaveProperty('copies');
    /* Who sees the order: the CEO and those who see the whole company. */
    const zed = await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } });
    expect([mine.priority, (await held(zed)).priority, theirs.priority]).toEqual([true, true, false]);
    /* With no copy there is no line about copies. */
    await db.update(machines).set({ role: 'worker', serverOrder: null, copyState: null, copyName: null }).where(eq(machines.id, mac));
    expect((await held(ceo)).copies).toBeNull();
  });

  it("knows the server's own computer by the machine id as well, and offers it no core", async () => {
    const { app, db } = await testApp({ HORNHOOF_MACHINE_ID: HOST_ID });
    const ceo = await setUpCompany(app);
    const host = (await join(app, await machineCommand(app, ceo), { machineId: HOST_KEY, hostname: 'server-box' })).json().machine.id as string;
    await db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.machineId, host));
    const shown = await listed(app, ceo);
    expect(shown.builtin.machine).toEqual({ id: host, hostname: 'server-box' });
    expect(shown.builtin).toMatchObject({ webPort: null, refusedBy: [] });
    expect(shown.machines.find(machine => machine.id === host)).toMatchObject({ core: null, needsCore: false });
  });
});
