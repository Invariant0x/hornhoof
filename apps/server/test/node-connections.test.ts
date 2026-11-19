import { createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { NodeMessage } from '@hornhoof/protocol';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Db } from '../src/db/client.js';
import { companies, departments, machines, nodeConnections, nodes, people } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { minuteRound } from '../src/modules/agents/timers.js';
import { dropOldConnections, nodeConnected, nodeDisconnected } from '../src/modules/nodes/connections.js';
import { NodeHub, type NodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { appOn, as, connectNode, createTestDb, invitePerson, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'builtin-node-key-0123456789abcdef';
const DAY = 24 * 60 * 60 * 1000;
/* A hub's round of pings that never comes during a test: the longest wait a timer takes. */
const QUIET = 2_147_483_647;

const SAID = {
  disconnectedAt: '2026-11-04T10:00:00.000Z',
  reconnectedAt: '2026-11-04T10:00:40.000Z',
  offlineMs: 40_000,
  attempts: 3,
  cause: 'dns_error' as const,
  closeCode: null,
  closeReason: null,
  errorCode: 'ENOTFOUND',
  error: 'getaddrinfo ENOTFOUND hornhoof.example',
  dnsFailed: true,
  watchdogTimedOut: false,
  clockJumpMs: null,
  networkChanged: true,
};
const REPORT: Extract<NodeMessage, { type: 'node.reconnect' }> = { type: 'node.reconnect', ...SAID, cause: 'dns_error' };
/* The network id of a machine whose own built-in node connects, with the key the node key makes for it. */
const MACHINE = 'b'.repeat(64);
const builtinKey = (machine: string) => `builtin.${machine}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${machine}`).digest('hex')}`;

/* A company with one machine of the CEO that carries two subscriptions, each its own node. */
async function joinedMachine(app: FastifyInstance, ceo: string) {
  const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude', 'codex'] }, ...as(ceo) });
  const code = connected.json().command.split('--join ')[1];
  const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } });
  const { machine, nodes: made } = joined.json();
  return { machineId: machine.id as string, keys: made.map((n: { key: string }) => n.key) as string[], ids: made.map((n: { nodeId: string }) => n.nodeId) as string[] };
}

async function liveCompany(env: NodeJS.ProcessEnv = {}, logger?: Parameters<typeof testApp>[1]) {
  const { app, db } = await testApp({ NODE_KEY, ...env }, logger);
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  return { app, db, url, ceo, ...(await joinedMachine(app, ceo)) };
}

const stored = (db: Db) => db.select().from(nodeConnections).orderBy(asc(nodeConnections.connectedAt));
const storedAre = (db: Db, n: number) => until(async () => (await stored(db)).length === n);
const endedAre = (db: Db, n: number) => until(async () => (await stored(db)).filter(r => r.disconnectedAt).length === n);

const history = (app: FastifyInstance, token: string, machineId: string) => app.inject({ url: `/api/machines/${machineId}/connections`, ...as(token) });

/* The node's mark comes back after every message it sent before was handled, one after the other as its socket keeps them. */
async function marked(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}

describe('the history of a node connection', () => {
  it('writes when a node connects, on its machine, and open while it stays', async () => {
    const { db, url, keys, ids, machineId } = await liveCompany();
    const [acme] = await db.select().from(companies);
    const before = Date.now();
    await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    const [row] = await stored(db);
    expect(row).toMatchObject({ companyId: acme!.id, machineId, nodeId: ids[0], disconnectedAt: null, cause: null, closeCode: null, closeReason: null, error: null, report: null });
    /* Between asking to connect and finding the row: when the node connected, whatever the time it took. */
    expect(row!.connectedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row!.connectedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('writes a node closing with the code and reason it gave, and how long it was away until it came back', async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    const node = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    node.ws.close(1000, 'Going away for an update.');
    await endedAre(db, 1);
    const [row] = await stored(db);
    expect(row).toMatchObject({ cause: 'node_closed', closeCode: 1000, closeReason: 'Going away for an update.' });
    expect(row!.disconnectedAt!.getTime()).toBeGreaterThanOrEqual(row!.connectedAt.getTime());

    const away = (await history(app, ceo, machineId)).json().events[0];
    expect(away).toMatchObject({ back: null, offlineMs: null, cause: 'node_closed' });
    /* The node comes back forty seconds later on the server's clock. */
    vi.useFakeTimers({ toFake: ['Date'], now: row!.disconnectedAt!.getTime() + 40_000 });
    onTestFinished(() => { vi.useRealTimers(); });
    await connectNode(url, keys[0]!);
    await storedAre(db, 2);
    const [, next] = await stored(db);
    const back = (await history(app, ceo, machineId)).json().events[0];
    expect(back.back).toBe(next!.connectedAt.toISOString());
    expect(back.offlineMs).toBe(next!.connectedAt.getTime() - row!.disconnectedAt!.getTime());
    expect(back.offlineMs).toBe(40_000);
  });

  it('writes a socket that was cut without a word as the network', async () => {
    const { db, url, keys } = await liveCompany();
    const node = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    node.ws.terminate();
    await endedAre(db, 1);
    expect((await stored(db))[0]).toMatchObject({ cause: 'network', closeCode: 1006, closeReason: null, error: null });
  });

  it('writes a node that stopped answering the pings as such', async () => {
    /* The pings go by a clock the test moves; nothing else of the server runs on intervals this short. */
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const { db, url, keys } = await liveCompany({ NODE_PING_MS: '20' });
    await connectNode(url, keys[0]!, { autoPong: false });
    /* Three pings go unanswered, and the round after them drops the node. */
    await vi.advanceTimersByTimeAsync(4 * 20);
    await endedAre(db, 1);
    expect((await stored(db))[0]).toMatchObject({ cause: 'missed_pongs', closeCode: 1006 });
  });

  it('writes an error on the socket with what it said', async () => {
    const { db, url, keys } = await liveCompany();
    const node = await connectNode(url, keys[0]!);
    node.ws.on('error', () => {});
    await storedAre(db, 1);
    /* No valid frame starts with these bits. */
    (node.ws as unknown as { _socket: { write(data: Buffer): void } })._socket.write(Buffer.from([0xff, 0xff]));
    await endedAre(db, 1);
    const [row] = await stored(db);
    expect(row).toMatchObject({ cause: 'socket_error' });
    expect(row!.error).toMatch(/invalid/i);
  });

  it('writes a socket a newer one of the same node replaced at once, with no time away, though the old one never answers', async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    const old = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    /* As on a line that went dead: the old socket stays open until its close times out, half a minute later. */
    (old.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    onTestFinished(() => old.ws.terminate());
    await connectNode(url, keys[0]!);
    await storedAre(db, 2);
    await endedAre(db, 1);
    const [first, second] = await stored(db);
    expect(first).toMatchObject({ cause: 'replaced', closeCode: 4000, closeReason: 'Replaced by a newer connection.', disconnectedAt: second!.connectedAt });
    expect(second).toMatchObject({ disconnectedAt: null });
    expect((await history(app, ceo, machineId)).json().events[0]).toMatchObject({ offlineMs: 0, cause: 'replaced' });
  });

  it('writes a machine disconnected in Hornhoof as that, and no drop of it', async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    expect((await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) })).statusCode).toBe(204);
    await endedAre(db, 1);
    expect((await stored(db))[0]).toMatchObject({ cause: 'disconnected', closeCode: 4001, closeReason: 'Disconnected in Hornhoof.' });
  });

  it('writes the server stopping while it still can, however the sockets then close', async () => {
    const { app, db, url, keys } = await liveCompany();
    await connectNode(url, keys[0]!);
    await connectNode(url, keys[1]!);
    await storedAre(db, 2);
    const stopping = Date.now();
    await app.close();
    const rows = await stored(db);
    expect(rows.map(r => [r.cause, r.closeCode])).toEqual([['server_stopped', 1001], ['server_stopped', 1001]]);
    for (const row of rows) expect(row.disconnectedAt!.getTime()).toBeGreaterThanOrEqual(stopping);
  });

  it('writes a server that died as stopped when it starts again, from when it last heard of the node', async () => {
    const client = (await createTestDb()).$client;
    const first = await appOn(client, { NODE_KEY });
    const ceo = await setUpCompany(first.app);
    const { machineId, ids } = await joinedMachine(first.app, ceo);
    const [acme] = await first.db.select().from(companies);
    const heard = new Date(Date.now() - 60_000);
    const connected = new Date(Date.now() - 3_600_000);
    await first.db.update(nodes).set({ lastSeenAt: heard }).where(eq(nodes.id, ids[0]!));
    await first.db.insert(nodeConnections).values([
      { companyId: acme!.id, machineId, nodeId: ids[0]!, connectedAt: connected },
      /* Connected after it last heard of the node: it cannot have been cut before that. */
      { companyId: acme!.id, machineId, nodeId: ids[1]!, connectedAt: new Date(Date.now() - 30_000) },
    ]);
    const before = await stored(first.db);
    await first.app.close();
    await first.db.update(nodeConnections).set({ disconnectedAt: null, cause: null, closeCode: null });
    expect((await stored(first.db)).filter(r => r.disconnectedAt)).toEqual([]);

    const second = await appOn(client, { NODE_KEY });
    await second.app.ready();
    const rows = await stored(second.db);
    expect(rows.map(r => [r.nodeId, r.cause, r.closeCode, r.disconnectedAt])).toEqual([
      [ids[0], 'server_stopped', null, heard],
      [ids[1], 'server_stopped', null, before[1]!.connectedAt],
    ]);
  });

  it('stops and says why when it cannot write the server stopping', async () => {
    const lines: string[] = [];
    const { app, db, url, keys } = await liveCompany({}, { level: 'error', stream: { write: (line: string) => void lines.push(line) } });
    await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('The database went away.');
    });
    await app.close();
    expect(lines.join('\n')).toContain('Writing that the server stopped into the history of node connections failed.');
    vi.restoreAllMocks();
  });

  it('removes the history of a node with the node', async () => {
    const { db, url, keys, ids } = await liveCompany();
    await connectNode(url, keys[0]!);
    await connectNode(url, keys[1]!);
    await storedAre(db, 2);
    await db.delete(nodes).where(eq(nodes.id, ids[0]!));
    expect((await stored(db)).map(r => r.nodeId)).toEqual([ids[1]]);
  });

  it('writes nothing and fails on nothing when the node it is about is gone', async () => {
    const lines: string[] = [];
    const { app, db, ids } = await liveCompany({}, { level: 'error', stream: { write: (line: string) => void lines.push(line) } });
    await db.delete(nodes).where(eq(nodes.id, ids[0]!));
    /* The hub hands a close to the app last, after the start and the end of the socket: once the app is done with it, the
       socket has nothing left to write or to fail on. */
    const closing = vi.spyOn((app.ctx.hub as unknown as { opts: { onClose(id: NodeIdentity): Promise<void> } }).opts, 'onClose');
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, terminate() {} });
    app.ctx.hub.attach({ kind: 'node', nodeId: ids[0]! }, socket as unknown as WebSocket);
    socket.emit('close', 1000, Buffer.from('Done.'));
    await until(() => closing.mock.results.length === 1);
    await closing.mock.results[0]!.value;
    expect(await stored(db)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('keeps no line of a built-in node, which has no machine of its own', async () => {
    const lines: string[] = [];
    const { db, url } = await liveCompany({}, { level: 'info', stream: { write: (line: string) => void lines.push(line) } });
    const node = await connectNode(url, NODE_KEY);
    node.ws.close(1000);
    await node.closed;
    /* The end of a connection goes to the log where a node's would be written: the history has had its chance. */
    await until(() => lines.some(l => l.includes('A node lost its connection.')));
    expect(await stored(db)).toEqual([]);
  });

  /* #1060: parts of runs went on the built-in node of test-server, and its drops were nowhere to be read. */
  it('writes the built-in node of a machine on that machine, with no node of its own, and how it ended', async () => {
    const lines: string[] = [];
    const { db, url, machineId } = await liveCompany({}, { level: 'info', stream: { write: (line: string) => void lines.push(line) } });
    const [acme] = await db.select().from(companies);
    await db.update(machines).set({ networkId: MACHINE }).where(eq(machines.id, machineId));
    const node = await connectNode(url, builtinKey(MACHINE));
    await storedAre(db, 1);
    expect((await stored(db))[0]).toMatchObject({ companyId: acme!.id, machineId, nodeId: null, disconnectedAt: null, cause: null });
    node.ws.close(1000);
    await endedAre(db, 1);
    expect((await stored(db))[0]).toMatchObject({ machineId, nodeId: null, cause: 'node_closed', closeCode: 1000 });
    const parsed = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.find(l => l.msg === 'A node connected.')).toMatchObject({ machine: 'dev-mac', node: 'builtin', offlineMs: null });
    expect(parsed.find(l => l.msg === 'A node lost its connection.')).toMatchObject({ machine: 'dev-mac', node: 'builtin', cause: 'node_closed', code: 1000 });
    /* Back, it says how long it was away, and what it said of the drop goes with that drop. */
    const back = await connectNode(url, builtinKey(MACHINE));
    await storedAre(db, 2);
    back.send(REPORT);
    await until(async () => (await stored(db))[0]!.report !== null);
    expect((await stored(db)).map(r => r.report)).toEqual([SAID, null]);
    await until(() => lines.filter(l => l.includes('A node connected.')).length === 2);
    expect(JSON.parse(lines.filter(l => l.includes('A node connected.'))[1]!)).toMatchObject({ machine: 'dev-mac', node: 'builtin', offlineMs: expect.any(Number) });
  });

  it('keeps the built-in node of a machine that is not one of a company in the log only', async () => {
    const { db, url } = await liveCompany();
    const node = await connectNode(url, builtinKey(MACHINE));
    node.ws.close(1000);
    await node.closed;
    const other = await connectNode(url, NODE_KEY);
    await marked(other);
    expect(await stored(db)).toEqual([]);
  });

  it('loses the query and the sign-in of any address a socket gave, in the history and in the log', async () => {
    const lines: string[] = [];
    const { db, url, keys } = await liveCompany({}, { level: 'info', stream: { write: (line: string) => void lines.push(line) } });
    const node = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    node.ws.close(1000, 'See HTTPS://user:pw@proxy.example/a?sig=abc123 now');
    await endedAre(db, 1);
    expect((await stored(db))[0]!.closeReason).toBe('See HTTPS://proxy.example/a now');
    await until(() => lines.some(l => l.includes('A node lost its connection.')));
    expect(lines.join('\n')).not.toContain('abc123');
    expect(lines.join('\n')).not.toContain('user:pw');
  });

  it('cuts a close reason and an error to their limits and keeps control characters out', async () => {
    const { db, ids } = await liveCompany();
    const hub = new NodeHub({
      pingMs: QUIET,
      onClose: async () => {},
      onMessage: async () => {},
      onDisconnected: (id, end) => nodeDisconnected({ db, log: { info: vi.fn() } } as never, id, end),
      onConnected: (id, link, at) => nodeConnected({ db, log: { info: vi.fn() } } as never, id, link, at),
    });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, terminate() {} });
    hub.attach({ kind: 'node', nodeId: ids[0]! }, socket as unknown as WebSocket);
    socket.emit('error', new Error(`Bad\nframe ${'e'.repeat(400)}`));
    socket.emit('close', 1002, Buffer.from(`Why\u0007 ${'r'.repeat(300)}`));
    await endedAre(db, 1);
    const [row] = await stored(db);
    expect(row!.error).toBe(`Bad frame ${'e'.repeat(290)}`);
    expect(row!.closeReason).toBe(`Why  ${'r'.repeat(195)}`);
  });

  it('loses a sign-in the limit would cut in two, one with an at sign in it and one with a control character', async () => {
    const { db, ids } = await liveCompany();
    const hub = new NodeHub({
      pingMs: QUIET,
      onClose: async () => {},
      onMessage: async () => {},
      onDisconnected: (id, end) => nodeDisconnected({ db, log: { info: vi.fn() } } as never, id, end),
      onConnected: (id, link, at) => nodeConnected({ db, log: { info: vi.fn() } } as never, id, link, at),
    });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {}, terminate() {} });
    hub.attach({ kind: 'node', nodeId: ids[0]! }, socket as unknown as WebSocket);
    const before = 'e'.repeat(270);
    socket.emit('error', new Error(`${before} https://user:secretsecretsecret@proxy.example/x`));
    socket.emit('close', 1002, Buffer.from('See https://user:p@ss@proxy.example/a and wss://us\u0007er:pw@proxy.example/b'));
    await endedAre(db, 1);
    const [row] = await stored(db);
    expect(row!.error).toBe(`${before} https://proxy.example/x`);
    expect(row!.closeReason).toBe('See https://proxy.example/a and wss://proxy.example/b');
  });
});

describe('what a node says of a drop when it is back', () => {
  async function backFromADrop() {
    const c = await liveCompany();
    const first = await connectNode(c.url, c.keys[0]!);
    await storedAre(c.db, 1);
    first.ws.terminate();
    await endedAre(c.db, 1);
    const second = await connectNode(c.url, c.keys[0]!);
    return { ...c, second };
  }

  it('goes with the drop it comes back from, both sides seen together, and not with the new connection', async () => {
    const { app, db, ceo, machineId, second } = await backFromADrop();
    second.send({ type: 'hello', version: '0.5.1', loggedIn: true, running: [] });
    second.send(REPORT);
    await until(async () => (await stored(db))[0]?.report !== null);
    const [drop, now] = await stored(db);
    expect(drop!.report).toEqual(SAID);
    expect(now!.report).toBeNull();
    const shown = (await history(app, ceo, machineId)).json().events[0].drops[0];
    expect(shown).toMatchObject({ cause: 'network', closeCode: 1006, report: SAID });
  });

  it('stays out of the way of a node from before, which says nothing', async () => {
    const { app, db, ceo, machineId, second } = await backFromADrop();
    second.send({ type: 'hello', version: '0.5.1', loggedIn: true, running: [] });
    await storedAre(db, 2);
    const shown = (await history(app, ceo, machineId)).json().events[0].drops[0];
    expect(shown).toMatchObject({ cause: 'network', report: null });
  });

  it('has nothing to go with on a first connection, and changes nothing', async () => {
    const { db, url, keys } = await liveCompany();
    const node = await connectNode(url, keys[0]!);
    node.send(REPORT);
    node.send({ type: 'hello', version: '0.5.1', loggedIn: true, running: [] });
    await until(async () => (await db.select(only(nodes, 'version')).from(nodes)).some(n => n.version === '0.5.1'));
    expect((await stored(db)).map(r => r.report)).toEqual([null]);
  });

  it('is not taken from a socket whose key is no longer the node key', async () => {
    const { db, second, ids } = await backFromADrop();
    await storedAre(db, 2);
    await db.update(nodes).set({ keyHash: 'another-key' }).where(eq(nodes.id, ids[0]!));
    second.send(REPORT);
    await second.closed;
    expect((await stored(db)).map(r => r.report)).toEqual([null, null]);
  });

  it('loses the query and the sign-in of any address in its words, as they go to people', async () => {
    const { db, second } = await backFromADrop();
    second.send({ ...REPORT, closeReason: 'See wss://proxy.example/a?sig=abc123', error: 'Redirected to https://user:secret@proxy.example/x?sig=abc123#part, then http://other.example/ok.' });
    await until(async () => (await stored(db))[0]?.report !== null);
    const said = (await stored(db))[0]!.report!;
    expect(said.closeReason).toBe('See wss://proxy.example/a');
    expect(said.error).toBe('Redirected to https://proxy.example/x, then http://other.example/ok.');
  });

  it('is not written for the built-in node', async () => {
    const { db, url } = await liveCompany();
    const node = await connectNode(url, NODE_KEY);
    node.send(REPORT);
    node.send({ type: 'hello', version: '0.5.1', loggedIn: true, running: [] });
    await marked(node);
    expect(await stored(db)).toEqual([]);
  });

  it('says what a second node said too, each with its own drop', async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    const [a, b] = await Promise.all(keys.map(k => connectNode(url, k)));
    await storedAre(db, 2);
    a!.ws.terminate();
    b!.ws.terminate();
    await endedAre(db, 2);
    const [againA, againB] = await Promise.all(keys.map(k => connectNode(url, k)));
    againA!.send(REPORT);
    againB!.send({ ...REPORT, cause: 'watchdog_timeout', errorCode: null, error: null, dnsFailed: false, watchdogTimedOut: true });
    await until(async () => (await stored(db)).filter(r => r.report).length === 2);
    const drops = (await history(app, ceo, machineId)).json().events[0].drops as { report: { cause: string } }[];
    expect(drops.map(d => d.report.cause).sort()).toEqual(['dns_error', 'watchdog_timeout']);
  });
});

describe('the server log of node connections', () => {
  it('says each coming and going in one line: machine, cause and code, and no key', async () => {
    const lines: string[] = [];
    const { db, url, keys, ids } = await liveCompany({}, { level: 'info', stream: { write: (line: string) => void lines.push(line) } });
    const node = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    node.ws.close(1000, 'Going.');
    await endedAre(db, 1);
    await connectNode(url, keys[0]!);
    await storedAre(db, 2);
    await until(() => lines.filter(l => l.includes('A node connected.')).length === 2);
    const parsed = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    const [connected, back] = parsed.filter(l => l.msg === 'A node connected.');
    expect(connected).toMatchObject({ level: 30, machine: 'dev-mac', node: ids[0], offlineMs: null });
    expect(back!.offlineMs).toEqual(expect.any(Number));
    expect(parsed.filter(l => l.msg === 'A node lost its connection.')).toEqual([expect.objectContaining({ level: 30, machine: 'dev-mac', node: ids[0], cause: 'node_closed', code: 1000, reason: 'Going.' })]);
    const all = lines.join('\n');
    for (const key of keys) expect(all).not.toContain(key);
    const hashes = (await db.select(only(nodes, 'keyHash')).from(nodes)).map(n => n.keyHash!);
    for (const hash of hashes) expect(all).not.toContain(hash);
  });

  it('says it of the built-in node too', async () => {
    const lines: string[] = [];
    const { url } = await liveCompany({}, { level: 'info', stream: { write: (line: string) => void lines.push(line) } });
    const node = await connectNode(url, NODE_KEY);
    await until(() => lines.some(l => l.includes('A node connected.')));
    node.ws.close(1000);
    await until(() => lines.some(l => l.includes('A node lost its connection.')));
    const parsed = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    expect(parsed.find(l => l.msg === 'A node connected.')).toMatchObject({ machine: 'built-in', node: 'builtin' });
    expect(parsed.find(l => l.msg === 'A node lost its connection.')).toMatchObject({ machine: 'built-in', node: 'builtin', cause: 'node_closed', code: 1000 });
    expect(lines.join('\n')).not.toContain(NODE_KEY);
  });
});

describe('how long the history stays', () => {
  async function aMachine() {
    const { app, db } = await testApp();
    const ceo = await setUpCompany(app);
    const made = await joinedMachine(app, ceo);
    const [acme] = await db.select().from(companies);
    return { app, db, ceo, companyId: acme!.id, ...made };
  }

  it('goes after fourteen days, unless the connection still stands', async () => {
    const { db, companyId, machineId, ids } = await aMachine();
    const now = new Date('2026-11-04T20:00:00Z');
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const nodeId = ids[0]!;
    const base = { companyId, machineId, nodeId, cause: 'network' as const };
    await db.insert(nodeConnections).values([
      { ...base, connectedAt: ago(20), disconnectedAt: new Date(ago(14).getTime() - 1) },
      { ...base, connectedAt: ago(15), disconnectedAt: ago(14) },
      { ...base, connectedAt: ago(13), disconnectedAt: ago(13) },
      { companyId, machineId, nodeId: ids[1]!, connectedAt: ago(40) },
    ]);
    expect(await dropOldConnections(db, now)).toBe(1);
    expect((await stored(db)).map(r => r.connectedAt)).toEqual([ago(40), ago(15), ago(13)]);
    expect(await dropOldConnections(db, now)).toBe(0);
  });

  it('keeps the newest two thousand of a machine that drops all day, and those that still stand, and leaves another machine alone', async () => {
    const { db, companyId, machineId, ids } = await aMachine();
    const now = new Date('2026-11-04T20:00:00Z');
    const [other] = await db.insert(machines).values({ companyId, personId: (await db.select().from(people))[0]!.id, machineKey: 'other-0001-abcd', hostname: 'other' }).returning();
    const [otherNode] = await db.insert(nodes).values({ companyId, machineId: other!.id, keyHash: 'other-key-hash', status: 'ready' }).returning();
    const at = (i: number) => new Date(now.getTime() - i * 1000);
    const flapping = Array.from({ length: 2003 }, (_, i) => ({ companyId, machineId, nodeId: ids[0]!, connectedAt: at(i + 1), disconnectedAt: at(i), cause: 'network' as const }));
    await db.insert(nodeConnections).values(flapping);
    /* Standing for longer than any of them, past the two thousandth. */
    await db.insert(nodeConnections).values({ companyId, machineId, nodeId: ids[1]!, connectedAt: at(100_000) });
    await db.insert(nodeConnections).values({ companyId, machineId: other!.id, nodeId: otherNode!.id, connectedAt: at(5000), disconnectedAt: at(4999), cause: 'network' });

    expect(await dropOldConnections(db, now)).toBe(3);
    const left = await stored(db);
    const ofMachine = left.filter(r => r.machineId === machineId);
    expect(ofMachine.filter(r => r.disconnectedAt)).toHaveLength(2000);
    expect(ofMachine.filter(r => r.disconnectedAt).map(r => r.connectedAt.getTime()).sort((a, b) => b - a)[0]).toBe(at(1).getTime());
    expect(Math.min(...ofMachine.filter(r => r.disconnectedAt).map(r => r.connectedAt.getTime()))).toBe(at(2000).getTime());
    expect(ofMachine.filter(r => !r.disconnectedAt)).toHaveLength(1);
    expect(left.filter(r => r.machineId === other!.id)).toHaveLength(1);
  });

  it('goes in the minute round', async () => {
    const { app, db, companyId, machineId, ids } = await aMachine();
    await db.insert(nodeConnections).values({ companyId, machineId, nodeId: ids[0]!, connectedAt: new Date(Date.now() - 30 * DAY), disconnectedAt: new Date(Date.now() - 29 * DAY), cause: 'network' });
    await minuteRound(app.ctx, new Date(), () => () => {});
    expect(await stored(db)).toEqual([]);
  });
});

describe('who gets the history of a machine', () => {
  it('is for those who see the machine: its owner and who sees the whole company', async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    const whole = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { whole: true } });
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'sales', roleCode: 'SAL' }).returning();
    const owner = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [sales!.id] } });
    const stranger = await invitePerson(app, ceo, { name: 'Max', email: 'max@acme.com', access: { departments: [sales!.id] } });
    expect((await history(app, ceo, machineId)).statusCode).toBe(200);
    expect((await history(app, whole, machineId)).statusCode).toBe(200);

    const none = await history(app, stranger, machineId);
    expect(none.statusCode).toBe(404);
    expect(none.json().error.reason).toBe('machine_unknown');

    const [ann] = await db.select().from(people).where(eq(people.email, 'ann@acme.com'));
    await db.update(machines).set({ personId: ann!.id }).where(eq(machines.id, machineId));
    expect((await history(app, owner, machineId)).statusCode).toBe(200);
    expect((await history(app, stranger, machineId)).statusCode).toBe(404);
  });

  it('is for no one signed out', async () => {
    const { app, machineId } = await liveCompany();
    expect((await app.inject({ url: `/api/machines/${machineId}/connections` })).statusCode).toBe(401);
  });

  it('goes with the machine: none for one that was disconnected, nor for an id that is none', async () => {
    const { app, ceo, machineId } = await liveCompany();
    await app.inject({ method: 'POST', url: `/api/machines/${machineId}/disconnect`, ...as(ceo) });
    expect((await history(app, ceo, machineId)).statusCode).toBe(404);
    expect((await history(app, ceo, '11111111-1111-4111-8111-111111111111')).statusCode).toBe(404);
    expect((await history(app, ceo, 'not-an-id')).statusCode).toBe(400);
  });

  it("gives no one the history of another company's machine, and only its own in its answer", async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    const node = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    node.ws.terminate();
    await endedAre(db, 1);
    const [other] = await db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const [person] = await db.insert(people).values({ companyId: other!.id, name: 'Other', email: 'other@example.test', status: 'active', scopeKind: 'company' }).returning();
    const [theirs] = await db.insert(machines).values({ companyId: other!.id, personId: person!.id, machineKey: 'theirs-0001-abcd', hostname: 'theirs' }).returning();
    const [theirNode] = await db.insert(nodes).values({ companyId: other!.id, machineId: theirs!.id, keyHash: 'their-key-hash', status: 'ready' }).returning();
    await db.insert(nodeConnections).values({ companyId: other!.id, machineId: theirs!.id, nodeId: theirNode!.id, connectedAt: new Date(Date.now() - 1000), disconnectedAt: new Date(), cause: 'network' });

    expect((await history(app, ceo, theirs!.id)).statusCode).toBe(404);
    const mine = (await history(app, ceo, machineId)).json();
    expect(mine.summary.drops).toBe(1);
    expect(JSON.stringify(mine)).not.toContain(theirNode!.id);
  });

  it('says no key of a node or a machine', async () => {
    const { app, db, url, ceo, keys, machineId } = await liveCompany();
    const node = await connectNode(url, keys[0]!);
    await storedAre(db, 1);
    node.ws.terminate();
    await endedAre(db, 1);
    const body = (await history(app, ceo, machineId)).body;
    expect(body).not.toContain(keys[0]);
    expect(body).not.toContain('mac-0001-abcd');
    expect(body).not.toContain((await db.select(only(nodes, 'keyHash')).from(nodes))[0]!.keyHash);
  });
});

describe('the node hub and the history of connections', () => {
  it('writes the start before the messages of the socket, and the end after them', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(done => (release = done));
    const hub = new NodeHub({
      pingMs: QUIET,
      onConnected: async () => {
        await gate;
        order.push('connected');
      },
      onMessage: async () => void order.push('message'),
      onDisconnected: async () => void order.push('disconnected'),
      onClose: async () => void order.push('close'),
    });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    socket.emit('message', JSON.stringify({ type: 'status', loggedIn: true, limits: null }));
    socket.emit('close', 1000, Buffer.from(''));
    release();
    await until(() => order.length === 3);
    expect(order).toEqual(['connected', 'disconnected', 'close']);
  });

  it('says a socket that closes after an error ended with the error, and one error is enough', async () => {
    const ends: unknown[] = [];
    const errors: unknown[] = [];
    const hub = new NodeHub({ pingMs: QUIET, onClose: async () => {}, onMessage: async () => {}, onDisconnected: async (_id, end) => void ends.push(end), onError: err => errors.push(err) });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    const first = new Error('First.');
    socket.emit('error', first);
    socket.emit('error', new Error('Second.'));
    socket.emit('close', 1006, Buffer.alloc(0));
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ cause: 'socket_error', code: 1006, reason: null, error: 'First.' });
    expect(errors[0]).toBe(first);
  });

  it('takes a close with no words as cut by the network', async () => {
    const ends: unknown[] = [];
    const hub = new NodeHub({ pingMs: QUIET, onClose: async () => {}, onMessage: async () => {}, onDisconnected: async (_id, end) => void ends.push(end) });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    socket.emit('close');
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ cause: 'network', code: 1006, reason: null, error: null });
  });

  it('says every socket ends with the server once the server is stopping, whatever closes it first', async () => {
    const ends: unknown[] = [];
    const hub = new NodeHub({ pingMs: QUIET, onClose: async () => {}, onMessage: async () => {}, onDisconnected: async (_id, end) => void ends.push(end) });
    onTestFinished(() => hub.stop());
    const socket = Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} });
    hub.attach(BUILTIN, socket as unknown as WebSocket);
    hub.stopping();
    socket.emit('close', 1005, Buffer.alloc(0));
    await until(() => ends.length === 1);
    expect(ends[0]).toMatchObject({ cause: 'server_stopped', code: 1005 });
  });

  it('ends a replaced socket only once, though it closes later', async () => {
    const ends: { link: string; cause: string }[] = [];
    let handled = 0;
    const hub = new NodeHub({ pingMs: QUIET, onClose: async () => void handled++, onMessage: async () => {}, onDisconnected: async (_id, end) => void ends.push(end) });
    onTestFinished(() => hub.stop());
    const closes: unknown[][] = [];
    const old = Object.assign(new EventEmitter(), { readyState: 1, close: (...args: unknown[]) => void closes.push(args), ping() {} });
    hub.attach(BUILTIN, old as unknown as WebSocket);
    hub.attach(BUILTIN, Object.assign(new EventEmitter(), { readyState: 1, close() {}, ping() {} }) as unknown as WebSocket);
    await until(() => ends.length === 1);
    expect(closes).toEqual([[4000, 'Replaced by a newer connection.']]);
    old.emit('close', 1006, Buffer.alloc(0));
    /* The close is handed on last, after any end it would write. */
    await until(() => handled === 1);
    expect(ends.map(e => e.cause)).toEqual(['replaced']);
  });
});
