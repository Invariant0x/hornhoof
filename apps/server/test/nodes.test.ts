import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents, departments, companies, nodeCodes, nodes, people, subscriptions } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };

const codeOf = (command: string) => command.split('--join ')[1]!;
const join = (app: FastifyInstance, code: string, extra: object = {}, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, ...MACHINE, ...extra }, headers });

async function connected(providers: string[]) {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const res = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers }, ...as(ceo) });
  return { app, db, ceo, code: codeOf(res.json().command), ids: res.json().subscriptions.map((s: { id: string }) => s.id) as string[] };
}

const machinesOf = async (app: FastifyInstance, token: string) => (await app.inject({ url: '/api/machines', ...as(token) })).json().machines;

describe('POST /api/nodes/join', () => {
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
    expect(list[0]).toMatchObject({ id: machine.id, hostname: 'ivan-mac', os: 'darwin', arch: 'arm64', owner: { name: 'Ivan' }, online: false, plans: [{ provider: 'claude' }, { provider: 'codex' }] });
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

  it('puts a plan that joined a machine on one more machine with a second command', async () => {
    const { app, db, ceo, code, ids } = await connected(['claude']);
    const extra = await app.inject({ method: 'POST', url: `/api/subscriptions/${ids[0]}/command`, ...as(ceo) });
    const first = (await join(app, code)).json();
    const late = await join(app, codeOf(extra.json().command), { machineId: 'other-machine-01', hostname: 'ivan-laptop' });
    expect(late.statusCode).toBe(200);
    expect(late.json().machine.id).not.toBe(first.machine.id);
    expect((await db.select().from(nodes).where(eq(nodes.subscriptionId, ids[0]))).map(n => n.machineId).sort()).toEqual([first.machine.id, late.json().machine.id].sort());
    expect(await db.select().from(subscriptions).where(eq(subscriptions.kind, 'personal'))).toHaveLength(1);
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
    expect(await machinesOf(app, ceo)).toMatchObject([{ id: node!.machineId, hostname: 'ivan-mac', owner: { name: 'Ivan' }, online: false, plans: [] }]);
    expect(await db.select().from(subscriptions).where(eq(subscriptions.kind, 'personal'))).toEqual([]);
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

  it('keeps its node when it joins again, with a new key', async () => {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const first = (await join(app, await machineCommand(app, ceo))).json().nodes[0];
    const again = (await join(app, await machineCommand(app, ceo))).json().nodes[0];
    expect(again.nodeId).toBe(first.nodeId);
    expect(again.key).not.toBe(first.key);
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
  const LAPTOP = { machineId: 'laptop-0002-abcd', hostname: 'ivan-laptop' };
  const machineCode = async (app: FastifyInstance, token: string) => codeOf((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command);
  const addPlan = (app: FastifyInstance, token: string, machineId: string, subscription: string) =>
    app.inject({ method: 'POST', url: `/api/machines/${machineId}/plans`, payload: { subscription }, ...as(token) });

  /* Ivan's Claude plan on his Mac, and his laptop joined without a plan. */
  async function twoMachines() {
    const { app, db, ceo, code, ids } = await connected(['claude']);
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
    expect(await machinesOf(app, ceo)).toMatchObject([{ hostname: 'ivan-mac', plans: [{ id: plan }] }, { hostname: 'ivan-laptop', plans: [{ id: plan }] }]);
  });

  it('works only on the machine it was made for, and stays unused there', async () => {
    const { app, ceo, plan, laptop } = await twoMachines();
    const code = codeOf((await addPlan(app, ceo, laptop.machine.id, plan)).json().command);
    const elsewhere = await join(app, code, { machineId: 'tower-0003-abcd', hostname: 'ivan-tower' });
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().error).toMatchObject({ reason: 'other_machine', message: expect.stringContaining('ivan-laptop') });
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
      { id: mac.machine.id, hostname: 'ivan-mac', status: 'needs_login', online: false },
      { id: laptop.machine.id, hostname: 'ivan-laptop', status: 'ready', online: true },
    ]);
    const tower = (await join(app, await machineCode(app, ceo), { machineId: 'tower-0003-abcd', hostname: 'ivan-tower' })).json();
    expect(await machinesOf(app, ceo)).toMatchObject([
      { id: mac.machine.id, plans: [{ id: plan, provider: 'claude', status: 'needs_login', online: false }] },
      { id: laptop.machine.id, plans: [{ id: plan, provider: 'claude', status: 'ready', online: true }] },
      { id: tower.machine.id, plans: [] },
    ]);
  });

  it('gives a plan a new key on a machine it is on already, and keeps the node', async () => {
    const { app, db, ceo, plan, mac } = await twoMachines();
    const again = (await join(app, codeOf((await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/command`, ...as(ceo) })).json().command))).json();
    expect(again.nodes[0].nodeId).toBe(mac.nodes[0].nodeId);
    expect(again.nodes[0].key).not.toBe(mac.nodes[0].key);
    expect(await db.select().from(nodes).where(eq(nodes.subscriptionId, plan))).toHaveLength(1);
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
    await app.inject({ method: 'POST', url: `/api/machines/${laptop.machine.id}/disconnect`, ...as(ceo) });
    expect(await status()).toBe('waiting_machine');
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
