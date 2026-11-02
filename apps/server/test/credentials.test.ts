import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { nodes, planCredentials, subscriptions } from '../src/db/schema.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

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
async function plans(provider: 'claude' | 'kimi' = 'claude') {
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
  const online = async (n: Joined, key: string) => {
    const node = await connectNode(url, n.key);
    node.send({ type: 'hello', version: '0.9.0', loggedIn: true, running: [], publicKey: key });
    await until(async () => (await db.select({ k: nodes.publicKey }).from(nodes).where(eq(nodes.id, n.nodeId)))[0]?.k === key);
    return node;
  };
  return { app, db, ceo, oleg, plan, a, b, o, online, lines };
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
    expect(await nextOf(na, 'cred.seal')).toEqual({ type: 'cred.seal', kind: 'claude_token', recipients: [{ nodeId: b.nodeId, publicKey: KEY('b') }] });
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
