import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { certificates, machines } from '../src/db/schema.js';
import { COPY_STATE, copyName } from '../src/modules/keeper/copy.js';
import { FollowKeeper, OWN_APP_AFTER_MS, type FollowKeeperOptions } from '../src/modules/keeper/follow.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { machineKey } from '../src/modules/keeper/machine-keys.js';
import { readKeeperState } from '../src/modules/keeper/state.js';
import { readTaking } from '../src/modules/keeper/taking.js';
import { readWord } from '../src/modules/keeper/updating.js';
import { LOAD_FILE, UPLOAD_FILE, UPLOADS_DIR, WIPE_FILE } from '../src/modules/keeper/uploads.js';
import { TEST_SECRET, until } from './helpers.js';
import { ask, company, folder, heldIn, HOST_ID, SLEEPER, worker, type Company } from './worker-keeper-fixture.js';

const LOOPBACK = '127.0.0.1';

/* A machine's database, for these tests: it sends back what it gets, with its own word first. */
async function tcpEcho(word: string): Promise<{ host: string; port: number }> {
  const server = net.createServer(socket => {
    socket.on('error', () => undefined);
    socket.on('data', chunk => socket.write(word + String(chunk)));
  });
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  onTestFinished(() => void server.close());
  return { host: LOOPBACK, port: (server.address() as AddressInfo).port };
}

/* The copy's own app, for these tests: it says who it is. */
async function ownApp(): Promise<{ host: string; port: number }> {
  const server = http.createServer((req, res) => void res.writeHead(200, { 'content-type': 'text/plain' }).end(`the copy's own app: ${req.url}`));
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { host: LOOPBACK, port: (server.address() as AddressInfo).port };
}

/* A database server that answers nothing: its database is empty, so the copy waits for its schema. Every statement is kept. */
function emptyCluster() {
  const run: string[] = [];
  const sql = (database: string): Sql & { close(): Promise<void> } => ({
    query: async <R>(text: string) => (run.push(`${database}: ${text.startsWith('DO $replica$') ? 'DO $replica$' : text}`), { rows: [] as R[] }),
    close: async () => undefined,
  });
  return { run, sql };
}

/* A machine that joined, was given the data by the server, and whose keeper is started anew as one that follows: as its
   updater leaves it once the settings are written. */
async function follower(c: Company, over: Partial<FollowKeeperOptions> = {}, before: (dir: string) => void = () => undefined) {
  const w = await worker(c);
  await until(async () => (await c.rowOf(w.machine)).ageKey !== null);
  await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
  await until(() => existsSync(join(w.config.controlDir, 'role.json')) && heldIn(w.config.dir).role === 'data');
  await w.stop();
  before(w.config.dir);
  const lines: string[] = [];
  const cluster = emptyCluster();
  const keeper = new FollowKeeper({
    config: { ...w.config, ticket: null, secret: Buffer.from(TEST_SECRET, 'base64'), databaseUrl: 'postgres://hornhoof@127.0.0.1:1/hornhoof' },
    frontHost: null,
    app: await ownApp(),
    db: await tcpEcho('copy: '),
    sql: cluster.sql,
    settings: async () => null,
    log: line => lines.push(line),
    host: LOOPBACK,
    doorHost: LOOPBACK,
    allowed: async () => [LOOPBACK],
    ports: { door: 0, peer: 0, peerApp: 0 },
    everyMs: 20,
    worker: {
      ports: { front: 0 }, visitClientFor: () => SLEEPER, lookEveryMs: 10, viewEveryMs: 30, reportEveryMs: 30, renewAfterMs: 50, renewEveryMs: 100, holdMs: 400, holdEveryMs: 10, noLeaderPageMs: 50,
      certificate: { retryMs: 20 }, sessions: { everyMs: 10, helloMs: 10, connectMs: 1000, directEveryMs: 50, pingMs: 60_000 }, computer: { openEveryMs: 10, closedEveryMs: 20 },
    },
    peerClientFor: () => SLEEPER,
    ...over,
  });
  const ports = await keeper.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await keeper.stop();
  };
  onTestFinished(stop);
  return { keeper, ports, lines, cluster, machine: w.machine, config: w.config, stop };
}

/* What a door answers one line with, or 'closed' when it takes no connection or ends it. */
function through(port: number, text: string): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect({ host: LOOPBACK, port });
    socket.on('error', () => resolve('closed'));
    socket.once('close', () => resolve('closed'));
    socket.once('data', chunk => {
      resolve(String(chunk));
      socket.destroy();
    });
    socket.write(text);
  });
}

/* As the keeper of a machine asks another's peer door, with the certificate its folder holds. */
function askingAt(port: number, certDir: string) {
  const held = heldIn(certDir);
  const session = http2.connect(`https://${LOOPBACK}:${port}`, { ca: held.authorityPem, cert: held.certPem, key: machineKey(certDir).privatePem, checkServerIdentity: () => undefined });
  session.on('error', () => undefined);
  onTestFinished(() => void session.destroy());
  return async (method: 'GET' | 'POST', path: string, body?: object) => {
    const stream = session.request({ ':method': method, ':path': path });
    stream.end(body ? JSON.stringify(body) : undefined);
    const status = await new Promise<number>(resolve => stream.once('response', headers => resolve(Number(headers[':status']))));
    let text = '';
    for await (const chunk of stream) text += String(chunk);
    return [status, text ? (JSON.parse(text) as unknown) : null];
  };
}

describe('the keeper of a machine that keeps a copy', () => {
  it('takes no lease and runs no link', async () => {
    const c = await company();
    const f = await follower(c);
    await until(() => f.keeper.status().leader !== null);
    expect(f.keeper.status()).toMatchObject({ role: 'data', certificate: true, disconnected: false });
    /* Its word to its app: off while the copy has no table, and never lead. */
    await until(() => readKeeperState(f.config.controlDir) !== null);
    expect(readKeeperState(f.config.controlDir)).toMatchObject({ mode: 'off', link: null });
    /* Nothing it asked its database touches a lease, and it asked for its schema. */
    await until(() => existsSync(join(f.config.controlDir, 'schema.json')));
    expect(f.cluster.run.some(line => /net_local\.lease|assert_lease|INSERT|UPDATE /.test(line))).toBe(false);
    /* The role the company server reads this machine's database with is made at the start. */
    expect(f.cluster.run).toContain('hornhoof: DO $replica$');
    expect(OWN_APP_AFTER_MS).toBe(60_000);
  });

  it("opens a door to the leader's database", async () => {
    const c = await company({ dbTarget: await tcpEcho('leader: ') });
    const f = await follower(c);
    await until(() => f.keeper.status().leader !== null);
    await until(async () => (await through(f.ports.door, 'ping')) === 'leader: ping');
    /* Nobody else's connection is carried there. */
    const closed = await follower(await company({ dbTarget: await tcpEcho('leader: ') }), { allowed: async () => ['192.0.2.1'] });
    await until(() => closed.keeper.status().leader !== null);
    expect(await through(closed.ports.door, 'ping')).toBe('closed');
  });

  it('reads by itself when the leader is gone', async () => {
    const c = await company();
    const f = await follower(c, { ownAppAfterMs: 100 });
    await until(() => f.keeper.status().leader !== null);
    /* With the leader in reach, the front door leads there. */
    expect((await ask(f.ports.front, { path: '/api/health' })).json()).toMatchObject({ ok: true });
    await c.stop();
    await until(async () => (await ask(f.ports.front, { path: '/tasks' }).catch(() => null))?.body === "the copy's own app: /tasks");
  });

  it('reports its copy', async () => {
    const c = await company();
    const f = await follower(c);
    const name = copyName(f.config.machineId, 1);
    await until(async () => (await c.rowOf(f.machine)).copyState === 'making');
    expect(await c.rowOf(f.machine)).toMatchObject({ copyState: 'making', copyProgress: 0, copyError: null, copyName: name });
    expect(f.keeper.status().copy).toMatchObject({ state: 'making', name });
    /* The request the updater gets names the door, and holds the password of the role it reads the leader with. */
    await until(() => existsSync(join(f.config.controlDir, 'schema.json')));
    expect(JSON.parse(readFileSync(join(f.config.controlDir, 'schema.json'), 'utf8'))).toMatchObject({ attempt: 1, database: 'hornhoof', port: 7432 });
    for (const line of f.lines) expect(line).not.toContain(TEST_SECRET);
  });
  it('answers the machine that leads about a planned switch, and ends once it took the go', async () => {
    const dir = folder();
    const c = await company({ dir });
    const sub = { enabled: true, did: [] as string[] };
    let exits = 0;
    const f = await follower(c, {
      taker: {
        copyReady: () => true,
        subscription: { enabled: async () => sub.enabled, applying: async () => sub.enabled, disable: async () => void ((sub.enabled = false), sub.did.push('disable')), enable: async () => void ((sub.enabled = true), sub.did.push('enable')) },
        exit: () => void (exits += 1),
      },
    });
    await until(() => f.keeper.status().leader !== null);
    const ports = await f.keeper.peerPorts();
    const asking = (certDir: string) => askingAt(ports.data, certDir);
    const id = '3f2b8c1e-7a4d-4e6f-9b10-5c2d8e7f1a23';
    const offer = { switch: id, term: { number: 5, machine: HOST_ID, split: false }, deadline: 0 };
    /* Another data machine, here this one itself, offers nothing: only the machine its link names as the leader does. */
    expect(await asking(f.config.dir)('POST', '/peer/switch/offer', offer)).toEqual([403, { ok: false }]);
    const leader = asking(dir);
    expect(await leader('POST', '/peer/switch/offer', offer)).toEqual([200, { ok: true }]);
    expect(readTaking(f.config.dir)).toMatchObject({ switch: id, phase: 'offered', from: { networkId: HOST_ID } });
    expect(await leader('GET', `/peer/switch/state?switch=${id}`)).toEqual([200, { state: 'offered', switch: id }]);
    expect(await leader('POST', '/peer/switch/go', { switch: id, w: '0/3000000', copies: [] })).toEqual([200, { ok: true }]);
    await until(() => exits === 1);
    expect([readTaking(f.config.dir)?.phase, sub.did]).toEqual(['go', ['disable']]);
    /* From here its subscription stays stopped: the copy's maker takes no step that would start it again. */
    const steps = f.cluster.run.length;
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(f.cluster.run.length).toBe(steps);
  });

  it('beats as a copy', async () => {
    const dir = folder();
    const c = await company({ dir, beatEveryMs: 20 });
    const f = await follower(c, { beatEveryMs: 20 });
    await until(() => f.keeper.status().leader !== null);
    /* The leader hears where the copy stands: it follows, and its copy is not whole yet. */
    await until(() => c.keeper.beats().last(f.config.machineId) !== null);
    expect(c.keeper.beats().last(f.config.machineId)!.beat).toMatchObject({ machine: f.config.machineId, stance: { kind: 'follow', term: null }, ready: false, full: false });
    /* And the copy hears the leader, by its answers. */
    await until(() => f.keeper.beats().answer(HOST_ID) !== null);
    expect(f.keeper.beats().last(HOST_ID)!.beat).toMatchObject({ machine: HOST_ID, stance: { kind: 'lead' }, ready: true });
    /* It answers a beat of the leader's with its own, and takes none that names another machine than the one that sent it. */
    const ports = await f.keeper.peerPorts();
    const leads = { machine: HOST_ID, host: 'debian', stance: { kind: 'idle', term: null }, number: 1, reach: null, ready: true, full: false };
    const [status, own] = await askingAt(ports.data, dir)('POST', '/peer/beat', leads);
    expect([status, own]).toMatchObject([200, { machine: f.config.machineId, stance: { kind: 'follow' } }]);
    expect(await askingAt(ports.data, f.config.dir)('POST', '/peer/beat', leads)).toEqual([403, { ok: false }]);
    expect(f.keeper.beats().last(HOST_ID)!.beat.stance.kind).not.toBe('attempting');
  });

  it('waits for the update', async () => {
    const dir = folder();
    const c = await company({ dir });
    const clock = { now: 0 };
    /* Its copy holds every table, so its app reads. */
    const f = await follower(c, { ownAppAfterMs: 100, updating: { now: () => clock.now } }, own => writeFileSync(join(own, COPY_STATE), JSON.stringify({ attempt: 1, database: 'hornhoof', phase: 'ready' })));
    await until(() => f.keeper.status().leader !== null);
    await until(() => readKeeperState(f.config.controlDir)?.mode === 'read');
    const ports = await f.keeper.peerPorts();
    const promise = { version: '0.19.0', until: 1000, migrations: 2 };
    /* Another data machine, here this one itself, is promised nothing: only the machine its link names as the leader is. */
    expect(await askingAt(ports.data, f.config.dir)('POST', '/peer/updating', promise)).toEqual([403, { ok: false }]);
    expect(await askingAt(ports.data, dir)('POST', '/peer/updating', promise)).toEqual([200, { ok: true }]);
    expect(readWord(f.config.controlDir)).toMatchObject({ leader: HOST_ID, version: '0.19.0', stopped: false });
    await until(() => readKeeperState(f.config.controlDir)?.mode === 'maintenance');
    /* The copy's maker takes no step while the word holds. */
    const made = () => f.cluster.run.filter(line => /SUBSCRIPTION|CREATE DATABASE|DROP DATABASE/.test(line)).length;
    const steps = made();
    /* The leader is gone for far longer than the time after which this machine would read by itself. */
    await c.stop();
    await until(() => f.keeper.status().leader === null);
    await new Promise(resolve => setTimeout(resolve, 400));
    const waiting = await ask(f.ports.front, { path: '/api/tasks' });
    expect([waiting.status, waiting.json()]).toMatchObject([503, { error: { reason: 'maintenance' } }]);
    expect([made(), readKeeperState(f.config.controlDir)?.mode]).toEqual([steps, 'maintenance']);
    /* The promise ran out: the app reads again, and the time with no leader counts from here. */
    clock.now = 1000;
    await until(() => readKeeperState(f.config.controlDir)?.mode === 'read');
    expect([readWord(f.config.controlDir), f.lines]).toEqual([null, expect.arrayContaining(["The company server's update promise ran out."])]);
    await until(async () => (await ask(f.ports.front, { path: '/tasks' }).catch(() => null))?.body === "the copy's own app: /tasks");
  });

  it('gives the leader what it holds once its owner lost the scope, and asks for its wipe only when the leader keeps it', async () => {
    const c = await company();
    const f = await follower(c, { leaving: { againMs: 50, retryMs: 20 } });
    await until(async () => (await c.rowOf(f.machine)).copyState === 'making');
    /* Its owner sees the whole company no more: the row as the server leaves it then, with its certificates revoked. */
    await c.db.update(machines).set({ role: 'worker', uploadState: 'waiting', dataLeftAt: new Date() }).where(eq(machines.id, f.machine));
    await c.db.update(certificates).set({ revokedAt: new Date() }).where(eq(certificates.machineId, f.machine));
    /* It hears so by the renewal it signs, stops serving its copy, and asks its updater for everything it holds. */
    const request = join(f.config.controlDir, UPLOAD_FILE);
    await until(() => existsSync(request));
    await until(() => readKeeperState(f.config.controlDir)?.mode === 'off');
    await until(() => heldIn(f.config.dir).role === 'worker');
    const { id } = JSON.parse(readFileSync(request, 'utf8')) as { id: string };
    /* The updater's part. */
    const uploads = join(f.config.controlDir, UPLOADS_DIR);
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, `${id}.tar.gz`), 'everything the copy held');
    writeFileSync(join(uploads, `${id}.done`), '');
    rmSync(request);
    /* The keeper that leads takes it, from this machine alone, and asks its own updater to load it. */
    const asked = join(c.control, LOAD_FILE);
    await until(() => existsSync(asked));
    const load = JSON.parse(readFileSync(asked, 'utf8')) as { machine: string; file: string };
    expect(load.machine).toBe(f.machine);
    expect(readFileSync(load.file, 'utf8')).toBe('everything the copy held');
    /* Nothing here goes while the leader has not said it keeps it: neither the upload nor what the keeper knows of its copy. */
    writeFileSync(join(f.config.dir, COPY_STATE), '{}');
    expect([existsSync(join(f.config.controlDir, WIPE_FILE)), readdirSync(uploads).sort()]).toEqual([false, [`${id}.done`, `${id}.tar.gz`]]);
    await c.db.update(machines).set({ uploadState: 'received' }).where(eq(machines.id, f.machine));
    await until(() => readdirSync(uploads).length === 0);
    expect([existsSync(join(f.config.controlDir, WIPE_FILE)), existsSync(join(f.config.dir, COPY_STATE))]).toEqual([false, true]);
    /* Merged and saved on the leader: now the machine asks its updater for the wipe. */
    await c.db.update(machines).set({ uploadState: 'kept' }).where(eq(machines.id, f.machine));
    await until(() => existsSync(join(f.config.controlDir, WIPE_FILE)));
    expect(existsSync(join(f.config.dir, COPY_STATE))).toBe(false);
    for (const line of f.lines) expect(line).not.toContain(TEST_SECRET);
  });
});
