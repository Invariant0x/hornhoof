import { randomUUID } from 'node:crypto';
import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket from 'ws';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { agents, companies, departments, machines, nodes, people, planCredentials, sessions, subscriptions } from '../src/db/schema.js';
import { idOnly, only } from '../src/db/selections.js';
import { LEASE_MOVE_MS, moveLeases } from '../src/modules/subscriptions/lease.js';
import { companyView } from '../src/modules/tools/company.js';
import { as, connectNode, invitePerson, listen, nextOf, openStream, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const MAC = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
const LAPTOP = { ...MAC, machineId: 'laptop-0002-abcd', hostname: 'dev-laptop' };
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

/* Whether the node got a message of this type from everything the server sent it so far; what came meanwhile is taken. A
   mark the node sends comes back after all of it, as one socket keeps their order, and after what the node said before was
   handled: no clock decides it. */
async function got(node: FakeNode, type: ServerMessage['type']): Promise<boolean> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
  let seen = false;
  for (let n = node.queued(); n > 0; n--) if ((await node.next()).type === type) seen = true;
  return seen;
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

  it('has a holder that comes online seal the sign-in for a node that waited', async () => {
    const { db, plan, a, b, online } = await plans();
    const first = await online(a, KEY('a'));
    first.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }] });
    await until(async () => (await stored(db, plan)).length === 1);
    first.close();
    await first.closed;
    /* B comes while the holder is away: nobody is there to seal for it. */
    const nb = await online(b, KEY('b'));
    expect(await got(nb, 'cred.put')).toBe(false);

    const na = await online(a, KEY('a'));
    expect(await nextOf(na, 'cred.put')).toEqual({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: SEALED('a') });
    expect(await nextOf(na, 'cred.seal')).toEqual({ type: 'cred.seal', kind: 'claude_token', version: 1, recipients: [{ nodeId: b.nodeId, publicKey: KEY('b') }] });
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: b.nodeId, sealed: SEALED('b') }] });
    expect(await nextOf(nb, 'cred.put')).toEqual({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: SEALED('b') });
  });

  it('asks a holder that comes online for nothing when every node of the plan holds the sign-in', async () => {
    const { db, plan, a, b, online } = await plans();
    const first = await online(a, KEY('a'));
    await online(b, KEY('b'));
    first.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }, { nodeId: b.nodeId, sealed: SEALED('b') }] });
    await until(async () => (await stored(db, plan)).length === 2);
    first.close();
    await first.closed;
    const na = await online(a, KEY('a'));
    expect(await nextOf(na, 'cred.put')).toMatchObject({ sealed: SEALED('a') });
    expect(await got(na, 'cred.seal')).toBe(false);
  });

  it('has a holder seal for no node without a key, and for none that was disconnected', async () => {
    const { app, db, ceo, plan, a, b, online } = await plans();
    const first = await online(a, KEY('a'));
    first.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }] });
    await until(async () => (await stored(db, plan)).length === 1);
    first.close();
    await first.closed;
    /* B never said a key. A third node of the plan had one, and its machine was disconnected. */
    const tower = (await join(app, await machineCode(app, ceo), { ...MAC, machineId: 'spare-0004-abcd', hostname: 'dev-spare' })).json();
    const added = await app.inject({ method: 'POST', url: `/api/machines/${tower.machine.id}/plans`, payload: { subscription: plan }, ...as(ceo) });
    const c = (await join(app, codeOf(added.json().command), { ...MAC, machineId: 'spare-0004-abcd', hostname: 'dev-spare' })).json().nodes[0] as Joined;
    const nc = await online(c, KEY('c'));
    nc.close();
    await nc.closed;
    expect((await app.inject({ method: 'POST', url: `/api/machines/${tower.machine.id}/disconnect`, ...as(ceo) })).statusCode).toBeLessThan(300);
    expect((await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, b.nodeId)))[0]!.k).toBeNull();

    const na = await online(a, KEY('a'));
    expect(await nextOf(na, 'cred.put')).toMatchObject({ sealed: SEALED('a') });
    expect(await got(na, 'cred.seal')).toBe(false);
  });

  it('throws out what was sealed to a key a node no longer has, and has the sign-in sealed to its new one', async () => {
    const { db, plan, a, b, online } = await plans();
    const na = await online(a, KEY('a'));
    const nb = await online(b, KEY('b'));
    na.send({ type: 'cred.sealed', kind: 'claude_token', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a') }, { nodeId: b.nodeId, sealed: SEALED('b') }] });
    await nextOf(nb, 'cred.put');
    /* The laptop's node was set up again and made a new key. */
    nb.close();
    const again = await online(b, KEY('c'));
    expect(await nextOf(na, 'cred.seal')).toEqual({ type: 'cred.seal', kind: 'claude_token', version: 1, recipients: [{ nodeId: b.nodeId, publicKey: KEY('c') }] });
    expect(await stored(db, plan)).toEqual([{ nodeId: a.nodeId, version: 1, sealed: SEALED('a') }]);
    expect(await got(again, 'cred.put')).toBe(false);
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
        { nodeId: a.nodeId, publicKey: KEY('a'), hostname: 'dev-mac' },
        { nodeId: b.nodeId, publicKey: KEY('b'), hostname: 'dev-laptop' },
      ]),
    });
    const theirs = await app.inject({ url: `/api/subscriptions/${plan}/recipients`, ...as(oleg) });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.reason).toBe('not_owner');
  });

  it('are open to the orchestrator acting for the owner', async () => {
    const { app, db, plan, a, online } = await plans('kimi');
    await online(a, KEY('a'));
    const [owner] = await db.select(idOnly(people)).from(people).where(eq(people.isOwner, true));
    const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(eq(agents.kind, 'orchestrator'));
    const headers = orchestratorHeaders(owner!.id, orchestrator!.id);
    const listed = await app.inject({ url: `/api/subscriptions/${plan}/recipients`, headers });
    expect(listed.json()).toMatchObject({ recipients: [{ nodeId: a.nodeId }] });
    const body = { kind: 'kimi_key', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('kimi') }] };
    const sent = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/credential`, payload: body, headers });
    expect(sent.json()).toEqual({ stored: 1 });
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
    expect(res.json()).toEqual({ nodeId: b.nodeId, hostname: 'dev-laptop' });
    expect(await nextOf(nb, 'login.start')).toEqual({ type: 'login.start', fresh: true });
    const theirs = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(oleg) });
    expect(theirs.statusCode).toBe(403);
    expect(theirs.json().error.reason).toBe('not_owner');
    const stop = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin/stop`, payload: { nodeId: b.nodeId }, ...as(ceo) });
    expect(stop.statusCode).toBe(204);
    expect(await nextOf(nb, 'login.stop')).toEqual({ type: 'login.stop' });
  });

  it("starts the sign-in for the orchestrator, on the owner's plan and on any other person's", async () => {
    const { app, db, oleg, plan, b, online } = await plans();
    const nb = await online(b, KEY('b'), false);
    const [owner] = await db.select(idOnly(people)).from(people).where(eq(people.isOwner, true));
    const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(eq(agents.kind, 'orchestrator'));
    const headers = orchestratorHeaders(owner!.id, orchestrator!.id);
    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, headers });
    expect(res.json()).toEqual({ nodeId: b.nodeId, hostname: 'dev-laptop' });
    expect(await nextOf(nb, 'login.start')).toEqual({ type: 'login.start', fresh: false });
    const olegs = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['codex'] }, ...as(oleg) })).json().subscriptions[0].id as string;
    const theirs = await app.inject({ method: 'POST', url: `/api/subscriptions/${olegs}/signin`, payload: { fresh: false }, headers });
    expect([theirs.statusCode, theirs.json().error.reason]).toEqual([409, 'no_node_online']);
  });

  it('starts the sign-in only on a machine with a key, which the new sign-in can be sealed to', async () => {
    const { app, db, ceo, plan, a, b, online, url } = await plans();
    /* The Mac's node is from before machine keys. */
    const na = await connectNode(url, a.key);
    na.send({ type: 'hello', version: '0.8.0', loggedIn: false, running: [], terminals: true });
    await until(async () => (await db.select({ v: nodes.version }).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.v === '0.8.0');
    const nb = await online(b, KEY('b'), false);
    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(ceo) });
    expect(res.json()).toEqual({ nodeId: b.nodeId, hostname: 'dev-laptop' });
    expect(await nextOf(nb, 'login.start')).toEqual({ type: 'login.start', fresh: false });
    const old = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { nodeId: a.nodeId, fresh: false }, ...as(ceo) });
    expect(old.statusCode).toBe(409);
    expect(await got(na, 'login.start')).toBe(false);
  });

  it('says whether no machine of the plan is online, or the online ones cannot run the sign-in', async () => {
    const { app, db, ceo, plan, a, b, url } = await plans('codex');
    const signIn = async () => (await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(ceo) })).json().error.reason;
    expect(await signIn()).toBe('no_node_online');
    /* The Mac's node is from before machine keys, and the laptop's shows no terminals. */
    const na = await connectNode(url, a.key);
    na.send({ type: 'hello', version: '0.8.0', loggedIn: true, running: [], terminals: true });
    const nb = await connectNode(url, b.key);
    nb.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('b'), terminals: false });
    await until(async () => (await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, b.nodeId)))[0]?.k === KEY('b'));
    await until(() => app.ctx.hub.isReady({ kind: 'node', nodeId: a.nodeId }) && app.ctx.hub.isReady({ kind: 'node', nodeId: b.nodeId }));
    expect(await signIn()).toBe('signin_unsupported');
  });

  it('names the machines whose nodes are too old for it, with the command that updates them and no code in it', async () => {
    const { app, ceo, plan, a, b, url } = await plans('codex');
    /* Both machines run nodes from before machine keys, as the Mac of the CEO did. */
    for (const n of [a, b]) (await connectNode(url, n.key)).send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
    await until(() => app.ctx.hub.isReady({ kind: 'node', nodeId: a.nodeId }) && app.ctx.hub.isReady({ kind: 'node', nodeId: b.nodeId }));
    const res = await app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(ceo) });
    expect(res.statusCode).toBe(409);
    /* The command that connects a machine, without its one-time code: the installer then updates the nodes on it. */
    const connect: string = (await app.inject({ method: 'POST', url: '/api/machines/command', ...as(ceo) })).json().command;
    expect(res.json().error).toEqual({
      code: 'conflict',
      message: expect.stringContaining('dev-mac, dev-laptop'),
      reason: 'signin_unsupported',
      details: { machines: ['dev-mac', 'dev-laptop'], command: connect.split(' -s -- --join ')[0] },
    });
    expect(res.json().error.details.command).toBe('curl -fsSL http://localhost:8080/install.sh | bash');
  });

  it("keeps one machine, its node and the plan's sign-in when the update brings an old node back, which then signs in here", async () => {
    const { app, db, ceo, plan, a, url } = await plans('codex');
    const signIn = () => app.inject({ method: 'POST', url: `/api/subscriptions/${plan}/signin`, payload: { fresh: false }, ...as(ceo) });
    const old = await connectNode(url, a.key);
    old.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
    await until(() => app.ctx.hub.isReady({ kind: 'node', nodeId: a.nodeId }));
    expect((await signIn()).json().error.reason).toBe('signin_unsupported');
    const before = await db.select().from(machines);
    /* The update replaced the node's container on its volume: it comes back with the same key and sign-in, on the new build. */
    old.close();
    const updated = await connectNode(url, a.key);
    updated.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true, publicKey: KEY('a'), build: 'c0ffee'.padEnd(40, '0') });
    await until(async () => (await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.k === KEY('a'));
    expect(await db.select().from(machines)).toEqual(before);
    expect(await db.select({ id: nodes.id, status: nodes.status }).from(nodes).where(eq(nodes.machineId, (await db.select(idOnly(machines)).from(machines).where(eq(machines.hostname, 'dev-mac')))[0]!.id))).toEqual([{ id: a.nodeId, status: 'ready' }]);
    expect((await db.select(only(subscriptions, 'status')).from(subscriptions).where(eq(subscriptions.id, plan)))[0]!.status).toBe('ready');
    expect((await signIn()).json()).toEqual({ nodeId: a.nodeId, hostname: 'dev-mac' });
    expect(await nextOf(updated, 'login.start')).toEqual({ type: 'login.start', fresh: false });
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

  it('passes a new size to the sign-in terminal and goes on past what is no frame', async () => {
    const { ceo, plan, a, online, url } = await plans();
    const na = await online(a, KEY('a'), false);
    const screen = await loginScreen(url, ceo, plan, a.nodeId);
    const open = await nextOf(na, 'term.open');
    screen.ws.send('not a frame');
    screen.ws.send(JSON.stringify({ type: 'nonsense', data: 'x' }));
    screen.ws.send(JSON.stringify({ type: 'resize', cols: 90, rows: 20 }));
    expect(await nextOf(na, 'term.resize')).toEqual({ type: 'term.resize', termId: open.termId, cols: 90, rows: 20 });
  });

  it('closes the sign-in terminal of a machine that is away, or shows no terminals', async () => {
    const { db, ceo, plan, a, b, url } = await plans();
    const closes = async (nodeId: string) => {
      const screen = await loginScreen(url, ceo, plan, nodeId);
      return new Promise<number>(resolve => screen.ws.on('close', code => resolve(code)));
    };
    expect(await closes(a.nodeId)).toBe(4410);
    const nb = await connectNode(url, b.key);
    nb.send({ type: 'hello', version: '0.9.0', loggedIn: false, running: [], publicKey: KEY('b'), terminals: false });
    await until(async () => (await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, b.nodeId)))[0]?.k === KEY('b'));
    expect(await closes(b.nodeId)).toBe(4404);
  });

  it('ends the sign-in terminal at once when its owner signs out, on the node too', async () => {
    const { app, ceo, plan, a, online, url } = await plans();
    const na = await online(a, KEY('a'), false);
    const screen = await loginScreen(url, ceo, plan, a.nodeId);
    const open = await nextOf(na, 'term.open');
    const closed = new Promise<number>(resolve => screen.ws.on('close', code => resolve(code)));
    await app.inject({ method: 'POST', url: '/api/auth/logout', ...as(ceo) });
    expect(await closed).toBe(4403);
    expect(await nextOf(na, 'term.close')).toEqual({ type: 'term.close', termId: open.termId });
  });

  it('passes no key of an owner whose session ended with nobody told, and closes', async () => {
    const { db, ceo, plan, a, online, url } = await plans();
    const na = await online(a, KEY('a'), false);
    /* Typed keys look at their person again once a second has gone since the last look: here the clock moves only when the
       test moves it. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const screen = await loginScreen(url, ceo, plan, a.nodeId);
    await nextOf(na, 'term.open');
    const closed = new Promise<number>(resolve => screen.ws.on('close', code => resolve(code)));
    screen.ws.send(JSON.stringify({ type: 'input', data: 'before' }));
    expect((await nextOf(na, 'term.input')).data).toBe('before');
    await db.delete(sessions);
    vi.advanceTimersByTime(60_000);
    screen.ws.send(JSON.stringify({ type: 'input', data: 'after' }));
    expect(await closed).toBe(4403);
    expect(await got(na, 'term.input')).toBe(false);
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
    await until(async () => (await db.select(only(nodes, 'account')).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.account?.tier === 'max');
    expect(await mine(app, ceo, plan)).toMatchObject({ accounts: [{ nodeId: a.nodeId, hostname: 'dev-mac', tier: 'max', email: 'ivan.plans@example.com' }], tier: 'max', accountsDiffer: false, signedInOnce: false, leaseMachine: null });

    /* Dana works in Sales only. The map shows her the orchestrator's state, but neither his plan nor Ivan's address. */
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const dana = await invitePerson(app, ceo, { name: 'Dana', email: 'dana@acme.com', access: { departments: [sales!.id] } });
    await db.update(agents).set({ subscriptionId: plan }).where(eq(agents.kind, 'orchestrator'));
    const org = (await app.inject({ method: 'GET', url: '/api/org', ...as(dana) })).json();
    expect(org.orchestrator).toMatchObject({ opens: false, subscription: null, machine: null });
    expect(JSON.stringify(org)).not.toContain('ivan.plans@example.com');
    const ceoOrg = (await app.inject({ method: 'GET', url: '/api/org', ...as(ceo) })).json();
    expect(ceoOrg.orchestrator.subscription.accounts[0].email).toBe('ivan.plans@example.com');
  });

  it("keeps the address from other people who see the whole company, and shows it to the orchestrator acting for the CEO", async () => {
    const { app, db, ceo, oleg, plan, a, url } = await plans();
    const na = await connectNode(url, a.key);
    na.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('a'), terminals: true, account: IVAN });
    await until(async () => (await db.select(only(nodes, 'account')).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.account?.tier === 'max');
    expect((await mine(app, ceo, plan)).accounts).toEqual([expect.objectContaining({ email: IVAN.email })]);
    expect((await mine(app, oleg, plan)).accounts).toEqual([{ nodeId: a.nodeId, hostname: 'dev-mac', tier: 'max' }]);
    const [owner] = await db.select(idOnly(people)).from(people).where(eq(people.isOwner, true));
    const [orchestrator] = await db.select(idOnly(agents)).from(agents).where(eq(agents.kind, 'orchestrator'));
    const seen = await app.inject({ method: 'GET', url: '/api/subscriptions', headers: orchestratorHeaders(owner!.id, orchestrator!.id) });
    expect(seen.statusCode).toBe(200);
    expect(seen.body).toContain('"tier":"max"');
    expect(seen.body).toContain(IVAN.email);
  });

  it('gets a note when its machines are on different plans of the maker', async () => {
    const { app, db, ceo, plan, a, b, url } = await plans();
    const na = await connectNode(url, a.key);
    const nb = await connectNode(url, b.key);
    na.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], terminals: true, account: { email: 'ivan@acme.com', tier: 'free' } });
    nb.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], terminals: true, account: null });
    nb.send({ type: 'status', loggedIn: true, limits: null, account: { email: 'ivan@acme.com', tier: 'pro' } });
    await until(async () => (await db.select(only(nodes, 'account')).from(nodes).where(eq(nodes.id, b.nodeId)))[0]?.account?.tier === 'pro');
    await until(async () => (await db.select(only(nodes, 'account')).from(nodes).where(eq(nodes.id, a.nodeId)))[0]?.account?.tier === 'free');
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
    /* The clock stands still from here: a machine is away from the moment Hornhoof saw it go, and each look at the leases
       says how long after that it is. */
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    na.close();
    await until(() => !p.app.ctx.hub.isOnline({ kind: 'node', nodeId: p.a.nodeId }));
    const holder = async () => (await p.db.select({ lease: subscriptions.leaseNodeId }).from(subscriptions).where(eq(subscriptions.id, p.plan)))[0]!.lease;
    return { ...p, nb, holder };
  }

  it('stays with a holder that has been away less than ten minutes', async () => {
    const { app, a, nb, holder } = await codex();
    await moveLeases(app.ctx, new Date(Date.now() + LEASE_MOVE_MS - 60_000));
    expect(await holder()).toBe(a.nodeId);
    expect(await got(nb, 'cred.lease')).toBe(false);
  });

  it('moves to a machine of the plan that is online once the holder has been away ten minutes, and the holder gives it up when back', async () => {
    const { app, a, b, nb, holder, url, ceo, plan } = await codex();
    await moveLeases(app.ctx, new Date(Date.now() + LEASE_MOVE_MS + 1000));
    expect(await holder()).toBe(b.nodeId);
    /* The Plans tab says the plan was signed in once and runs on the laptop now. */
    const listed = ((await app.inject({ method: 'GET', url: '/api/subscriptions', ...as(ceo) })).json().subscriptions as { id: string }[]).find(s => s.id === plan);
    expect(listed).toMatchObject({ signedInOnce: true, leaseMachine: 'dev-laptop' });
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
    await until(async () => (await db.select(only(nodes, 'status')).from(nodes).where(eq(nodes.id, b.nodeId)))[0]!.status === 'needs_login');
    await moveLeases(app.ctx, new Date(Date.now() + 3 * LEASE_MOVE_MS));
    expect(await holder()).toBe(b.nodeId);
    expect(await got(nb, 'cred.lease')).toBe(false);
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
    expect(await got(back, 'cred.put')).toBe(false);
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

  it('takes a sealed sign-in only from the machine that holds the plan', async () => {
    const { a, b, nb, url, db, plan } = await codex();
    await db.update(subscriptions).set({ leaseNodeId: b.nodeId }).where(eq(subscriptions.id, plan));
    /* The Mac held the plan before and seals the sign-in it still had, which Codex has renewed on the laptop since. */
    const back = await connectNode(url, a.key);
    back.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: KEY('a'), terminals: true });
    expect(await nextOf(back, 'cred.lease')).toEqual({ type: 'cred.lease', hold: false });
    back.send({ type: 'cred.sealed', kind: 'codex_auth', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a-old') }, { nodeId: b.nodeId, sealed: SEALED('b-old') }] });
    /* A message after it shows it was handled. */
    back.send({ type: 'status', loggedIn: false, limits: null });
    await until(async () => (await db.select(only(nodes, 'status')).from(nodes).where(eq(nodes.id, a.nodeId)))[0]!.status === 'needs_login');
    expect(await stored(db, plan)).toEqual([{ nodeId: a.nodeId, version: 1, sealed: SEALED('a') }, { nodeId: b.nodeId, version: 1, sealed: SEALED('b') }].sort((x, y) => x.nodeId.localeCompare(y.nodeId)));
    nb.send({ type: 'cred.sealed', kind: 'codex_auth', version: 1, envelopes: [{ nodeId: a.nodeId, sealed: SEALED('a-new') }] });
    await until(async () => (await stored(db, plan)).find(s => s.nodeId === a.nodeId)?.sealed === SEALED('a-new'));
  });

  it('has a machine that joined the plan later sealed the sign-in by the holder, ready to take over', async () => {
    const p = await plans('codex');
    const na = await p.online(p.a, KEY('a'));
    na.send({ type: 'cred.sealed', kind: 'codex_auth', version: 1, envelopes: [{ nodeId: p.a.nodeId, sealed: SEALED('a') }] });
    await until(async () => (await stored(p.db, p.plan)).length === 1);
    await p.db.update(subscriptions).set({ leaseNodeId: p.a.nodeId }).where(eq(subscriptions.id, p.plan));
    const nb = await p.online(p.b, KEY('b'), false);
    expect(await nextOf(nb, 'cred.lease')).toEqual({ type: 'cred.lease', hold: false });
    expect(await nextOf(na, 'cred.seal')).toEqual({ type: 'cred.seal', kind: 'codex_auth', version: 1, recipients: [{ nodeId: p.b.nodeId, publicKey: KEY('b') }] });
  });

  it('gives a holder that comes back signed out its envelope and whom to seal a renewal for', async () => {
    const { a, b, url } = await codex();
    const back = await connectNode(url, a.key);
    back.send({ type: 'hello', version: '0.9.0', loggedIn: false, running: [], publicKey: KEY('a'), terminals: true });
    expect(await nextOf(back, 'cred.put')).toEqual({ type: 'cred.put', kind: 'codex_auth', version: 1, sealed: SEALED('a') });
    const told = await nextOf(back, 'cred.seal');
    expect(told).toMatchObject({ kind: 'codex_auth', version: 1 });
    expect(told.recipients.map(r => r.nodeId).sort()).toEqual([a.nodeId, b.nodeId].sort());
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
