import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { certificates, machines } from '../src/db/schema.js';
import { COPY_STATE, copyName } from '../src/modules/keeper/copy.js';
import { FollowKeeper, OWN_APP_AFTER_MS, type FollowKeeperOptions } from '../src/modules/keeper/follow.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { readKeeperState } from '../src/modules/keeper/state.js';
import { LOAD_FILE, UPLOAD_FILE, UPLOADS_DIR, WIPE_FILE } from '../src/modules/keeper/uploads.js';
import { TEST_SECRET, until } from './helpers.js';
import { ask, company, heldIn, SLEEPER, worker, type Company } from './worker-keeper-fixture.js';

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
async function follower(c: Company, over: Partial<FollowKeeperOptions> = {}) {
  const w = await worker(c);
  await until(async () => (await c.rowOf(w.machine)).ageKey !== null);
  await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
  await until(() => existsSync(join(w.config.controlDir, 'role.json')) && heldIn(w.config.dir).role === 'data');
  await w.stop();
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
