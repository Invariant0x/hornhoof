import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { agents, companies, departments, nodes, planCredentials, subscriptions } from '../src/db/schema.js';
import { LEASE_MOVE_MS, moveLeases } from '../src/modules/subscriptions/lease.js';
import { companyView } from '../src/modules/tools/company.js';
import { as, connectNode, invitePerson, listen, openStream, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const MAC = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
const LAPTOP = { ...MAC, machineId: 'laptop-0002-abcd', hostname: 'ivan-laptop' };
const TOWER = { ...MAC, machineId: 'tower-0003-abcd', hostname: 'oleg-tower' };
const KEY = (c: string) => 'age1' + c.repeat(58);
const SEALED = (n: string) => `-----BEGIN AGE ENCRYPTED FILE-----\nSEALEDMARK${n}\n-----END AGE ENCRYPTED FILE-----\n`;

const codeOf = (command: string) => command.split('--join ')[1]!;
const join = (app: FastifyInstance, code: string, machine: object) => app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, ...machine } });
const machineCode = async (app: FastifyInstance, token: string) => codeOf((await app.inject({ method: 'POST', url: '/api/machines/command', ...as(token) })).json().command);

type Joined = { nodeId: string; key: string };

/* Ivan's plan on his Mac (a) and his laptop (b), and Oleg's Codex plan on his tower (o). */
async function plans(provider: 'claude' | 'kimi' | 'codex' = 'claude') {
  const lines: string[] = [];
  const { app, db } = await testApp({}, { level: 'trace', stream: { write: (line: string) => void lines.push(line) } });
  const ceo = await setUpCompany(app);
  const connected = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: [provider] }, ...as(ceo) })).json();
  const plan = connected.subscriptions[0].id as string;
  const a = (await join(app, codeOf(connected.command), MAC)).json().nodes[0] as Joined;
  const laptop = (await join(app, await machineCode(app, ceo), LAPTOP)).json();
  const added = await app.inject({ method: 'POST', url: `/api/machines/${laptop.machine.id}/plans`, payload: { subscription: plan }, ...as(ceo) });
  const b = (await join(app, codeOf(added.json().command), LAPTOP)).json().nodes[0] as Joined;
  const oleg = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
  const olegs = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(oleg) })).json();
  const o = (await join(app, codeOf(olegs.command), TOWER)).json().nodes[0] as Joined;
  const url = await listen(app);
  /* A node that says hello with its key and waits until Hornhoof has it. */
  const online = async (n: Joined, key: string, loggedIn = true) => {
    const node = await connectNode(url, n.key);
    node.send({ type: 'hello', version: '0.9.0', loggedIn, running: [], publicKey: key, terminals: true });
    await until(async () => (await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, n.nodeId)))[0]?.k === key);
    return node;
  };
  return { app, db, ceo, oleg, plan, olegsPlan: olegs.subscriptions[0].id as string, a, b, o, online, lines, url };
}

/* The next message of this type, past the others. */
async function nextOf<T extends ServerMessage['type']>(node: FakeNode, type: T, ms = 2000): Promise<Extract<ServerMessage, { type: T }>> {
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`No ${type} arrived.`);
    const m = await Promise.race([node.next(), new Promise<null>(r => setTimeout(() => r(null), left))]);
    if (m?.type === type) return m as Extract<ServerMessage, { type: T }>;
  }
}

const stored = async (db: Awaited<ReturnType<typeof plans>>['db'], plan: string) =>
  (await db.select({ nodeId: planCredentials.nodeId, version: planCredentials.version, sealed: planCredentials.sealed }).from(planCredentials).where(eq(planCredentials.subscriptionId, plan))).sort((x, y) => x.nodeId.localeCompare(y.nodeId));

describe("a plan's sign-in sealed to its nodes", () => {
  it('keeps the key a node says hello with', async () => {
    const { db, a, online } = await plans();
    await online(a, KEY('a'));
    expect((await db.select().from(nodes).where(eq(nodes.id, a.nodeId)))[0]).toMatchObject({ publicKey: KEY('a') });
  });

  it('keeps what a node of the plan sealed and hands it to each other node of the plan that is online', async () => {
    const { db, plan, a, b, online } = await plans();
    const na = await online(a, KEY('a'));
    const nb = await online(b, KEY('b'));
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }, { nodeId: b.nodeId, sealed: SEALED('b') }] });
    expect(await nextOf(nb, 'cred.put')).toEqual({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: SEALED('b') });
    expect(await stored(db, plan)).toEqual([{ nodeId: a.nodeId, version: 1, sealed: SEALED('a') }, { nodeId: b.nodeId, version: 1, sealed: SEALED('b') }].sort((x, y) => x.nodeId.localeCompare(y.nodeId)));
    expect((await db.select({ v: subscriptions.credVersion }).from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.v).toBe(1);
  });

  it("drops what names a node of another plan, comes from one, is of another kind or is older than what it has", async () => {
    const { db, plan, a, b, o, online } = await plans();
    const na = await online(a, KEY('a'));
    const no = await online(o, KEY('o'));
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 2, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a2') }, { nodeId: o.nodeId, sealed: SEALED('o') }] });
    await until(async () => (await stored(db, plan)).length === 1);
    no.send({ type: 'cred.sealed', kind: 'claude_token', version: 9, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('evil') }] });
    na.send({ type: 'cred.sealed', kind: 'glm_key', version: 9, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('glm') }] });
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a1') }, { nodeId: b.nodeId, sealed: SEALED('b1') }] });
    /* A message after them all shows they were handled. */
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 2, envelopes: [{ nodeId: b.nodeId, sealed: SEALED('b2') }] });
    await until(async () => (await stored(db, plan)).length === 2);
    expect(await stored(db, plan)).toEqual([{ nodeId: a.nodeId, version: 2, sealed: SEALED('a2') }, { nodeId: b.nodeId, version: 2, sealed: SEALED('b2') }].sort((x, y) => x.nodeId.localeCompare(y.nodeId)));
    expect(await db.select().from(planCredentials).where(eq(planCredentials.nodeId, o.nodeId))).toEqual([]);
  });

  it('throws out the older sign-in of a node the newer one leaves out', async () => {
    const { db, plan, a, b, online } = await plans();
    const na = await online(a, KEY('a'));
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a1') }, { nodeId: b.nodeId, sealed: SEALED('b1') }] });
    await until(async () => (await stored(db, plan)).length === 2);
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 2, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a2') }] });
    await until(async () => (await stored(db, plan)).length === 1);
    expect(await stored(db, plan)).toEqual([{ nodeId: a.nodeId, version: 2, sealed: SEALED('a2') }]);
  });

  it('hands a node that comes online later its sign-in at once', async () => {
    const { db, plan, a, b, online } = await plans();
    const na = await online(a, KEY('a'));
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }, { nodeId: b.nodeId, sealed: SEALED('b') }] });
    await until(async () => (await stored(db, plan)).length === 2);
    const nb = await online(b, KEY('b'));
    expect(await nextOf(nb, 'cred.put')).toEqual({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: SEALED('b') });
  });

  it('asks a node that holds the sign-in to seal it for a node of the plan that has none', async () => {
    const { db, plan, a, b, online } = await plans();
    const na = await online(a, KEY('a'));
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }] });
    await until(async () => (await stored(db, plan)).length === 1);
    await online(b, KEY('b'));
    expect(await nextOf(na, 'cred.seal')).toEqual({ type: 'cred.seal', kind: 'claude_token', version: 1, recipients: [{ nodeId: b.nodeId, publicKey: KEY('b') }] });
  });
});

describe('the sealing routes', () => {
  it("list the plan's nodes with their keys to its owner alone", async () => {
    const { app, ceo, oleg, plan, a, b, online } = await plans();
    await online(a, KEY('a'));
    await online(b, KEY('b'));
    const mine = await app.inject({ url: `/api/subscriptions/${plan}/recipients`, ...as(ceo) });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({
      version: 0,
      recipients: expect.arrayContaining([
        { nodeId: a.nodeId, publicKey: KEY('a'), hostname: 'ivan-mac' },
        { nodeId: b.nodeId, publicKey: KEY('b'), hostname: 'ivan-laptop' },
      ]),
    });
    const theirs = await app.inject({ url: `/api/subscriptions/${plan}/recipients`, ...as(oleg) });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.reason).toBe('not_owner');
  });

  it("keep a key the owner sealed in the browser, hand it to the plan's nodes and refuse a Codex or Claude sign-in", async () => {
    const { app, db, ceo, oleg, plan, a, online, lines } = await plans('kimi');
    const na = await online(a, KEY('a'));
    const body = { kind: 'kimi_key', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('kimi') }] };
    const theirs = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/credential`, payload: body, ...as(oleg) });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.reason).toBe('not_owner');
    for (const kind of ['codex_auth', 'claude_token']) expect((await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/credential`, payload: { ...body, kind }, ...as(ceo) })).statusCode).toBe(400);
    const glm = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/credential`, payload: { ...body, kind: 'glm_key' }, ...as(ceo) });
    expect(glm.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/credential`, payload: body, ...as(ceo) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ stored: 1 });
    expect(await nextOf(na, 'cred.put')).toEqual({ type: 'cred.put', kind: 'kimi_key', version: 1, sealed: SEALED('kimi') });
    expect(await stored(db, plan)).toHaveLength(1);
    /* What is sealed never comes back in an answer or a log line. */
    const seen = [ok.body, theirs.body, glm.body, ...lines];
    for (const url of ['/api/subscriptions', '/api/machines', `/api/subscriptions/${plan}/recipients`]) seen.push((await app.inject({ url, ...as(ceo) })).body);
    expect(seen.join('\n')).not.toContain('SEALEDMARK');
  });

  it("throw out a removed plan's sealed sign-ins", async () => {
    const { app, db, ceo, plan, a, online } = await plans('kimi');
    await online(a, KEY('a'));
    await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/credential`, payload: { kind: 'kimi_key', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('kimi') }] }, ...as(ceo) });
    expect((await app.inject({ method: 'DELETE', url: `/api/subscriptions/${plan}`, ...as(ceo) })).statusCode).toBe(204);
    expect(await stored(db, plan)).toEqual([]);
  });
});

/* The owner's browser on a node's sign-in terminal. */
function loginScreen(url: string, token: string, plan: string, nodeId: string): Promise<{ ws: WebSocket; frames: { type: string; [k: string]: unknown }[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace('/api/nodes/socket', `/api/subscriptions/${plan}/signin/terminal?nodeId=${nodeId}&cols=100&rows=30`), { headers: { cookie: `hh_session=${token}` } });
    const frames: { type: string; [k: string]: unknown }[] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data))));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => resolve({ ws, frames }));
  });
}

describe('signing a plan in from Hornhoof', () => {
  it("starts the sign-in on one of the owner's online machines, and on no machine of another person's plan", async () => {
    const { app, ceo, oleg, plan, a, b, online } = await plans();
    const none = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(ceo) });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.reason).toBe('no_node_online');
    await online(a, KEY('a'), false);
    const nb = await online(b, KEY('b'), false);
    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { nodeId: b.nodeId, fresh: true }, ...as(ceo) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodeId: b.nodeId, hostname: 'ivan-laptop' });
    expect(await nextOf(nb, 'login.start')).toEqual({ type: 'login.start', fresh: true });
    const theirs = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(oleg) });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.reason).toBe('not_owner');
    const stop = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin/stop`, payload: { nodeId: b.nodeId }, ...as(ceo) });
    expect(stop.statusCode).toBe(204);
    expect(await nextOf(nb, 'login.stop')).toEqual({ type: 'login.stop' });
  });

  it('signs Kimi in with a pasted key instead of a terminal', async () => {
    const { app, ceo, plan, a, online } = await plans('kimi');
    await online(a, KEY('a'), false);
    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(ceo) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.reason).toBe('wrong_kind');
  });

  it("opens the sign-in terminal to the plan's owner alone, who types into it", async () => {
    const { ceo, oleg, plan, a, online, url } = await plans();
    const na = await online(a, KEY('a'), false);
    const screen = await loginScreen(url, ceo, plan, a.nodeId);
    const open = await nextOf(na, 'term.open');
    expect(open).toMatchObject({ agentKey: 'login', cols: 100, rows: 30, write: true });
    await until(() => screen.frames.length > 0);
    expect(screen.frames[0]).toEqual({ type: 'ready', write: true });
    na.send({ type: 'term.data', termId: open.termId, data: 'Paste code here' });
    await until(() => screen.frames.length > 1);
    expect(screen.frames[1]).toEqual({ type: 'data', data: 'Paste code here' });
    screen.ws.send(JSON.stringify({ type: 'input', data: 'abc\r' }));
    expect(await nextOf(na, 'term.input')).toEqual({ type: 'term.input', termId: open.termId, data: 'abc\r' });
    screen.ws.close();
    expect(await nextOf(na, 'term.close')).toEqual({ type: 'term.close', termId: open.termId });
    await expect(loginScreen(url, oleg, plan, a.nodeId)).rejects.toThrow('HTTP 403');
  });

  it("keeps the CEO out of another person's sign-in terminal", async () => {
    const { ceo, olegsPlan, o, online, url } = await plans();
    await online(o, KEY('o'), false);
    await expect(loginScreen(url, ceo, olegsPlan, o.nodeId)).rejects.toThrow('HTTP 403');
  });

  it("tells the owner how it ended, seals the new sign-in for the plan's nodes and is ready once the node says so", async () => {
    const { app, db, ceo, plan, a, b, online } = await plans();
    const stream = await openStream(app, ceo);
    const na = await online(a, KEY('a'), false);
    await online(b, KEY('b'), false);
    na.send({ type: 'login.done', ok: true, error: null });
    const seal = await nextOf(na, 'cred.seal');
    expect(seal).toMatchObject({ kind: 'claude_token', version: 1 });
    expect(seal.recipients.map(r => r.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
    await until(() => stream.messages.some(m => m.type === 'subscription.signin'));
    expect(stream.messages.find(m => m.type === 'subscription.signin')).toEqual({ type: 'subscription.signin', subscriptionId: plan, nodeId: a.nodeId, ok: true, error: null, owner: expect.any(String) });
    na.send({ type: 'status', loggedIn: true, limits: null });
    await until(async () => (await db.select({ s: subscriptions.status }).from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.s === 'ready');
  });

  it('says a failed sign-in only to the plan owner', async () => {
    const { app, ceo, oleg, olegsPlan, o, online } = await plans();
    const ceoStream = await openStream(app, ceo);
    const olegStream = await openStream(app, oleg);
    const no = await online(o, KEY('o'), false);
    no.send({ type: 'login.done', ok: false, error: 'The sign-in window was closed.' });
    await until(() => olegStream.messages.some(m => m.type === 'subscription.signin'));
    expect(olegStream.messages.find(m => m.type === 'subscription.signin')).toMatchObject({ subscriptionId: olegsPlan, ok: false, error: 'The sign-in window was closed.' });
    /* The CEO sees the plan's state change, not its sign-in. */
    await until(() => ceoStream.messages.some(m => m.type === 'org'));
    expect(ceoStream.messages.some(m => m.type === 'subscription.signin')).toBe(false);
  });

  it('gives the Codex plan to the machine it was signed in on', async () => {
    const { db, olegsPlan, o, online } = await plans();
    const no = await online(o, KEY('o'), false);
    no.send({ type: 'login.done', ok: true, error: null });
    expect(await nextOf(no, 'cred.seal')).toEqual({ type: 'cred.seal', kind: 'codex_auth', version: 1, recipients: [{ nodeId: o.nodeId, publicKey: KEY('o') }] });
    await until(async () => (await db.select({ l: subscriptions.leaseNodeId }).from(subscriptions).where(eq(subscriptions.id, olegsPlan)))[0]!.l === o.nodeId);
  });
});

describe('which account a plan runs on', () => {
  const IVAN = { email: 'ivan.plans@example.com', tier: 'max' };
  const mine = async (app: FastifyInstance, token: string, plan: string) =>
    ((await app.inject({ method: 'GET', url: '/api/subscriptions', ...as(token) })).json().subscriptions as { id: string }[]).find(s => s.id === plan) as Record<string, unknown>;

  it('is kept as each node tells it, with the address for the plan\'s owner only', async () => {
    const { app, db, ceo, plan, a, url } = await plans();
    const na = await connectNode(url, a.key);
    na.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('a'), terminals: true, account: IVAN });
    await until(async () => (await db.select({ account: nodes.account }).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.account?.tier === 'max');
    expect(await mine(app, ceo, plan)).toMatchObject({ accounts: [{ nodeId: a.nodeId, hostname: 'ivan-mac', tier: 'max', email: 'ivan.plans@example.com' }], tier: 'max', accountsDiffer: false });

    /* Dana works in Sales only. The map shows her the orchestrator's plan, which is Ivan's, without his address. */
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.com', access: { departments: [sales!.id] } });
    await db.update(agents).set({ subscriptionId: plan }).where(eq(agents.kind, 'orchestrator'));
    const org = (await app.inject({ method: 'GET', url: '/api/org', ...as(dana) })).json();
    expect(org.orchestrator.subscription).toMatchObject({ id: plan, tier: 'max', accounts: [{ nodeId: a.nodeId, tier: 'max' }] });
    expect(JSON.stringify(org)).not.toContain('ivan.plans@example.com');
    const ceoOrg = (await app.inject({ method: 'GET', url: '/api/org', ...as(ceo) })).json();
    expect(ceoOrg.orchestrator.subscription.accounts[0].email).toBe('ivan.plans@example.com');
  });

  it('gets a note when its machines are on different plans of the maker', async () => {
    const { app, db, ceo, plan, a, b, url } = await plans();
    const na = await connectNode(url, a.key);
    const nb = await connectNode(url, b.key);
    na.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], terminals: true, account: { email: 'ivan@acme.com', tier: 'free' } });
    nb.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], terminals: true, account: null });
    nb.send({ type: 'status', loggedIn: true, limits: null, account: { email: 'ivan@acme.com', tier: 'pro' } });
    await until(async () => (await db.select({ account: nodes.account }).from(nodes).where(eq(nodes.id, b.nodeId)))[0]?.account?.tier === 'pro');
    await until(async () => (await db.select({ account: nodes.account }).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.account?.tier === 'free');
    expect(await mine(app, ceo, plan)).toMatchObject({ tier: null, accountsDiffer: true });
  });

  it('reaches agents as its tier alone', async () => {
    const { app, db, a } = await plans();
    await db.update(nodes).set({ account: IVAN }).where(eq(nodes.id, a.nodeId));
    const [acme] = await db.select().from(companies);
    const view = await companyView(db, app.ctx.templates, acme!.id);
    expect(view.subscriptions.find(s => s.provider === 'claude')).toMatchObject({ tier: 'max' });
    expect(JSON.stringify(view)).not.toContain('@');
  });
});

describe("a Codex plan's lease", () => {
  /* Ivan's Codex plan on his Mac (a), which holds it, and his laptop (b), both with the sign-in sealed to them. */
  async function codex() {
    const p = await plans('codex');
    const na = await p.online(p.a, KEY('a'));
    const nb = await p.online(p.b, KEY('b'));
    na.send({ type: 'cred.sealed', kind: 'codex_auth', version: 1, envelopes: [{ nodeId: p.a.nodeId, sealed: SEALED('a') }, { nodeId: p.b.nodeId, sealed: SEALED('b') }] });
    await until(async () => (await stored(p.db, p.plan)).length === 2);
    await p.db.update(subscriptions).set({ leaseNodeId: p.a.nodeId }).where(eq(subscriptions.id, p.plan));
    na.close();
    await until(() => !p.app.ctx.hub.isOnline({ kind: 'node', nodeId: p.a.nodeId }));
    const holder = async () => (await p.db.select({ lease: subscriptions.leaseNodeId }).from(subscriptions).where(eq(subscriptions.id, p.plan)))[0]!.lease;
    return { ...p, nb, holder };
  }

  it('stays with a holder that has been away less than ten minutes', async () => {
    const { app, a, nb, holder } = await codex();
    await moveLeases(app.ctx, new Date(Date.now() + LEASE_MOVE_MS - 60_000));
    expect(await holder()).toBe(a.nodeId);
    await expect(nextOf(nb, 'cred.lease', 300)).rejects.toThrow();
  });

  it('moves to a machine of the plan that is online once the holder has been away ten minutes, and the holder gives it up when back', async () => {
    const { app, a, b, nb, holder, url } = await codex();
    await moveLeases(app.ctx, new Date(Date.now() + LEASE_MOVE_MS + 1000));
    expect(await holder()).toBe(b.nodeId);
    expect(await nextOf(nb, 'cred.lease')).toEqual({ type: 'cred.lease', hold: true });
    expect(await nextOf(nb, 'cred.put')).toEqual({ type: 'cred.put', kind: 'codex_auth', version: 1, sealed: SEALED('b') });
    /* The new holder learns whom to seal a renewed sign-in for. */
    expect((await nextOf(nb, 'cred.seal')).recipients.map(r => r.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
    const back = await connectNode(url, a.key);
    back.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('a'), terminals: true });
    expect(await nextOf(back, 'cred.lease')).toEqual({ type: 'cred.lease', hold: false });
  });

  it('stays with a new holder whose sign-in Codex no longer takes, and nothing goes round', async () => {
    const { app, a, b, nb, holder, db } = await codex();
    await moveLeases(app.ctx, new Date(Date.now() + LEASE_MOVE_MS + 1000));
    await nextOf(nb, 'cred.seal');
    /* The sign-in the old holder sealed was used up by a refresh it never sent: the new holder is signed out. */
    nb.send({ type: 'status', loggedIn: false, limits: null });
    await until(async () => (await db.select({ status: nodes.status }).from(nodes).where(eq(nodes.id, b.nodeId)))[0]!.status === 'needs_login');
    await moveLeases(app.ctx, new Date(Date.now() + 3 * LEASE_MOVE_MS));
    expect(await holder()).toBe(b.nodeId);
    await expect(nextOf(nb, 'cred.lease', 300)).rejects.toThrow();
    void a;
  });

  it('stays when no other machine of the plan is online', async () => {
    const { app, a, b, nb, holder } = await codex();
    nb.close();
    await until(() => !app.ctx.hub.isOnline({ kind: 'node', nodeId: b.nodeId }));
    await moveLeases(app.ctx, new Date(Date.now() + LEASE_MOVE_MS + 1000));
    expect(await holder()).toBe(a.nodeId);
  });

  it('is not handed back to its holder, who keeps the sign-in Codex renewed, and goes to a new holder that lost it', async () => {
    const { a, b, nb, url, db, plan } = await codex();
    const back = await connectNode(url, a.key);
    back.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('a'), terminals: true });
    const told = await nextOf(back, 'cred.seal');
    expect(told).toMatchObject({ kind: 'codex_auth', version: 1 });
    expect(told.recipients.map(r => r.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
    await expect(nextOf(back, 'cred.put', 300)).rejects.toThrow();
    /* The laptop says hello again: it holds no lease, so it is told to give up any sign-in. */
    nb.close();
    const laptop = await connectNode(url, b.key);
    laptop.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('b'), terminals: true });
    expect(await nextOf(laptop, 'cred.lease')).toEqual({ type: 'cred.lease', hold: false });
    /* Made the holder, it says hello signed out: it gets its envelope. */
    await db.update(subscriptions).set({ leaseNodeId: b.nodeId }).where(eq(subscriptions.id, plan));
    laptop.close();
    const again = await connectNode(url, b.key);
    again.send({ type: 'hello', version: '0.9.0', loggedIn: false, running: [], publicKey: KEY('b'), terminals: true });
    expect(await nextOf(again, 'cred.put')).toEqual({ type: 'cred.put', kind: 'codex_auth', version: 1, sealed: SEALED('b') });
  });

  it('goes to the machine that signed in, and the others give theirs up', async () => {
    const { a, b, nb, url, holder } = await codex();
    const back = await connectNode(url, a.key);
    back.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('a'), terminals: true });
    await nextOf(back, 'cred.seal');
    nb.send({ type: 'login.done', ok: true, error: null });
    await until(async () => (await holder()) === b.nodeId);
    expect(await nextOf(back, 'cred.lease')).toEqual({ type: 'cred.lease', hold: false });
    void a;
  });
});
