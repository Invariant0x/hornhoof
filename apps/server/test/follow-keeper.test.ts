import { ChildProcess } from 'node:child_process';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { certificates, machines } from '../src/db/schema.js';
import type { TunnelSettings } from '../src/modules/link/tunnel.js';
import { CERT_FILE } from '../src/modules/keeper/certificate.js';
import type { Beat } from '../src/modules/keeper/beats.js';
import { COPY_STATE, copyName } from '../src/modules/keeper/copy.js';
import { FollowKeeper, OWN_APP_AFTER_MS, type FollowKeeperOptions } from '../src/modules/keeper/follow.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { machineKey, writePrivately } from '../src/modules/keeper/machine-keys.js';
import { RECOVERY_FILE } from '../src/modules/keeper/question.js';
import { readKeeperState } from '../src/modules/keeper/state.js';
import { readTaking } from '../src/modules/keeper/taking.js';
import { readFollowed } from '../src/modules/keeper/watch.js';
import { PROMISE_MS } from '../src/modules/keeper/update-steps.js';
import { readWord } from '../src/modules/keeper/updating.js';
import { HOLD } from '../src/net/proxy.js';
import { LOAD_FILE, UPLOAD_FILE, UPLOADS_DIR, WIPE_FILE } from '../src/modules/keeper/uploads.js';
import { PEERS_FILE } from '../src/modules/keeper/worker.js';
import { issueCertificate, makeAuthority, makeCrl } from '../src/modules/network/authority.js';
import { renewedMessage } from '../src/modules/network/renewal.js';
import { TEST_SECRET, until as stateUntil } from './helpers.js';
import { ask, company, folder, heldIn, HOST_ID, hostIdOf, MAC, SLEEPER, worker, type Company } from './worker-keeper-fixture.js';
import { controlledTime, fetchApp, manualTime, registerStep, until } from './worker-keeper-time.js';

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

/* One round of a keeper that follows, taken by the test instead of its timers: its worker's part as the fixture takes a
   worker's, then its own look after the copy, its beats, its watch over the leader, the CEO's answer and its peer
   tunnel; and the leader's beats, while the leader runs. */
function followerRound(c: Company, keeper: FollowKeeper): () => void {
  const inner = keeper['worker'];
  return registerStep(async () => {
    inner.parts().certificates['look']();
    const link = inner.parts().link;
    link['look']();
    for (const kept of link['kept']) if (kept.session) link['hello'](kept.session, kept);
    inner['look']();
    await inner['tunnel']?.['tick']();
    if (!c.stopped() && inner.status().leader && !inner.status().disconnected) {
      await inner['doorWork'];
      await inner['readView']();
      await inner['report']();
      await inner['carrier'].tick();
      await inner['holder'].round();
    } else await inner['holder'].survive();
    keeper['look']();
    await keeper['working'];
    await keeper['beating'].tick();
    await keeper['watcher'].tick();
    await keeper['recovery'].tick();
    await keeper['tunnel']?.['tick']();
    if (!c.stopped()) await c.keeper.beats().tick();
  });
}

/* Rounds of every keeper the test runs, each a moment of msEach later than the one before. */
async function rounds(count: number, msEach = 1): Promise<void> {
  for (let round = 0; round < count; round++) {
    vi.setSystemTime(Date.now() + msEach - 1);
    await until(() => true);
  }
}

/* A machine that joined, was given the data by the server, and whose keeper is started anew as one that follows: as its
   updater leaves it once the settings are written. */
async function follower(c: Company, over: Partial<FollowKeeperOptions> = {}, before: (dir: string) => void | Promise<void> = () => undefined) {
  const w = await worker(c);
  await until(async () => (await c.rowOf(w.machine)).ageKey !== null);
  await c.db.update(machines).set({ role: 'data' }).where(eq(machines.id, w.machine));
  await until(() => existsSync(join(w.config.controlDir, 'role.json')) && heldIn(w.config.dir).role === 'data');
  await w.stop();
  await before(w.config.dir);
  const lines: string[] = [];
  const cluster = emptyCluster();
  const manual = manualTime();
  /* On rounds, its clocks go by the test's: the wall and the time since it started both move with each round. */
  const began = Date.now();
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
    peerClientFor: () => SLEEPER,
    ...(manual ? { clocks: () => ({ wall: Date.now(), mono: Date.now() - began }) } : {}),
    ...over,
    worker: {
      ports: { front: 0 }, visitClientFor: () => SLEEPER, lookEveryMs: 10, viewEveryMs: 30, reportEveryMs: 30, renewAfterMs: 50, renewEveryMs: 100, holdMs: 400, holdEveryMs: 10, noLeaderPageMs: 50,
      certificate: { retryMs: 20 }, sessions: { everyMs: 10, helloMs: 10, connectMs: 1000, directEveryMs: 50, pingMs: 60_000 }, computer: { openEveryMs: 10, closedEveryMs: 20 },
      ...(manual ? { fetch: fetchApp, holdMs: 0 } : {}),
      ...over.worker,
    },
  });
  const ports = await keeper.start();
  const removeRound = manual ? followerRound(c, keeper) : () => undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    removeRound();
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
  beforeEach(controlledTime);

  it('waits for no copy of its own, as a database that led did', async () => {
    const c = await company();
    /* This machine led before, and the name of the copy its commits waited for is still in its database's setting:
       whatever writes there now, its keeper or its updater, would wait for a copy that follows it no more. */
    const asked: string[] = [];
    let names = 'FIRST 1 ("copy_b0b0b0b0b0b0b0b0_1")';
    const sql = (database: string): Sql & { close(): Promise<void> } => ({
      query: async <R>(text: string) => {
        if (text.includes('current_setting')) return { rows: [{ names }] as R[] };
        if (text.startsWith('ALTER SYSTEM') || text.includes('pg_reload_conf')) asked.push(`${database}: ${text}`);
        if (text.includes('pg_reload_conf')) names = '';
        return { rows: [] as R[] };
      },
      close: async () => undefined,
    });
    await follower(c, { sql });
    await until(() => asked.length === 2);
    /* Asked of the server's own database: the copy's is not there while it changes places with a new one. */
    expect(asked).toEqual(['postgres: ALTER SYSTEM RESET synchronous_standby_names', 'postgres: SELECT pg_reload_conf()']);
    /* Once, not at each look. */
    await rounds(10);
    expect(asked).toHaveLength(2);
  });

  it('opens its door to the other machines by what it kept, with no leader in reach', async () => {
    const c = await company();
    /* The machine that led is gone before this keeper starts, as when the server was handed over and never taken, or
       the leader stopped: no view comes, and whoever asks this machine where it stands must still get in. */
    const f = await follower(c, {}, () => c.stop());
    /* It listens as it starts, with no round taken: no leader's word is waited for. */
    const ports = await f.keeper.peerPorts();
    /* Its own certificate is one of the company's, and the list it kept is the one the leader signed. */
    expect(await askingAt(ports.data, f.config.dir)('GET', '/peer/hello')).toMatchObject([200, { role: 'data', lead: false }]);
  });

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
  });

  it("carries nobody else's connection through that door", async () => {
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
  it('measures nothing of its disk while it makes its copy', async () => {
    /* Pouring the copy in is what keeps the disk busy then: a probe would only measure that. */
    const c = await company();
    const f = await follower(c, { worker: { sampleMs: 1 } });
    await until(async () => (await c.rowOf(f.machine)).copyState === 'making');
    for (let reports = 0; reports < 3; reports++) {
      const { reportAt } = await c.rowOf(f.machine);
      await until(async () => (await c.rowOf(f.machine)).reportAt!.getTime() > reportAt!.getTime());
    }
    expect(existsSync(join(f.config.dir, 'fsync-probe'))).toBe(false);
    expect(await c.rowOf(f.machine)).toMatchObject({ copyState: 'making', fsyncP99Ms: null });
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
    await rounds(10);
    expect(f.cluster.run.length).toBe(steps);
  });

  it('beats as a copy', async () => {
    const dir = folder();
    const c = await company({ dir, beatEveryMs: 20 });
    const f = await follower(c, { beatEveryMs: 20 });
    /* Every beat the leader hears, in turn: the first from the copy is sent before the copy heard the leader. */
    const heard: Beat[] = [];
    const lasts = c.keeper.beats()['lasts'];
    const keep = lasts.set.bind(lasts);
    lasts.set = (machine, last) => (heard.push(last.beat), keep(machine, last));
    await until(() => f.keeper.status().leader !== null);
    /* The leader hears where the copy stands: it follows no term yet, and its copy is not whole. */
    await until(() => heard.some(beat => beat.machine === f.config.machineId));
    expect(heard.find(beat => beat.machine === f.config.machineId)).toMatchObject({ machine: f.config.machineId, stance: { kind: 'follow', term: null }, ready: false, full: false });
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

  it('follows the term of the machine it was made on, and promises that machine the next one', async () => {
    const dir = folder();
    const c = await company({ dir, beatEveryMs: 20 });
    /* Its maker wrote down which machine the copy was made on. */
    const f = await follower(c, { beatEveryMs: 20 }, own => writeFileSync(join(own, COPY_STATE), JSON.stringify({ attempt: 1, database: 'hornhoof', phase: 'ready', leader: HOST_ID })));
    await until(() => f.keeper.status().leader !== null);
    /* The leader's beats say under which term it leads: that is the term this copy follows, written down. */
    await until(() => readFollowed(f.config.dir) !== null);
    const followed = readFollowed(f.config.dir)!;
    expect(followed).toMatchObject({ machine: 'machine-a', split: false });
    await until(() => c.keeper.beats().last(f.config.machineId)?.beat.stance.kind === 'follow' && (c.keeper.beats().last(f.config.machineId)!.beat.stance as { term: unknown }).term !== null);
    expect(c.keeper.beats().last(f.config.machineId)!.beat.stance).toEqual({ kind: 'follow', term: followed });
    const ports = await f.keeper.peerPorts();
    const next = { number: followed.number + 1, machine: followed.machine, split: false };
    /* Only a machine of the company that keeps data is answered at all, and only the machine it follows is promised anything. */
    const leader = askingAt(ports.data, dir);
    expect(await leader('POST', '/peer/promise', {})).toEqual([400, { ok: false }]);
    const [status, said] = await leader('POST', '/peer/promise', { term: { ...next, machine: f.config.machineId } });
    expect([status, said]).toMatchObject([200, { machine: f.config.machineId, stance: { kind: 'follow', term: followed } }]);
    expect(readFollowed(f.config.dir)).toEqual(followed);
  });

  it('takes the server over by writing that down and ending, once its watch says so', async () => {
    const dir = folder();
    const c = await company({ dir, beatEveryMs: 20 });
    const sub = { enabled: true, did: [] as string[] };
    let exits = 0;
    /* A clock on which each round is a second, and a relay the test plays: the name is free at 7, and its record names
       this copy as the one that holds every change. */
    const began = Date.now();
    const clocks = () => {
      const ms = (Date.now() - began) * 1000;
      return { wall: 1_700_000_000_000 + ms, mono: ms };
    };
    const name = { state: 'held' as 'held' | 'empty' };
    let own = '';
    const f = await follower(
      c,
      {
        beatEveryMs: 20, clocks,
        taker: { subscription: { enabled: async () => sub.enabled, applying: async () => sub.enabled, disable: async () => void ((sub.enabled = false), sub.did.push('disable')), enable: async () => void (sub.enabled = true) }, exit: () => void (exits += 1) },
        watcher: {
          everyMs: 20, ready: () => true,
          link: () => ({ name: 'acme', key: 'k'.repeat(32) }),
          relay: {
            route: async () => ({ known: true, state: name.state, client: null, since: 0, generation: 7, relayStarted: 100, evictionBound: 30, sync: { state: 'on', copy: own, epoch: 1, generation: 7, at: 1 } }),
            health: async () => ({ up: true, relayStarted: 100 }),
          },
          probe: async () => null,
        },
        recovery: { everyMs: 20 },
      },
      folderOf => writeFileSync(join(folderOf, COPY_STATE), JSON.stringify({ attempt: 1, database: 'hornhoof', phase: 'ready', leader: HOST_ID })),
    );
    own = f.config.machineId;
    await until(() => f.keeper.status().leader !== null && readFollowed(f.config.dir) !== null);
    /* The leader says its commits wait for this copy. */
    await until(() => f.keeper.beats().last(HOST_ID)?.beat.stance.kind === 'lead');
    expect(readTaking(f.config.dir)).toBeNull();
    /* While the leader beats, nothing is taken, whatever the name says. */
    name.state = 'empty';
    await rounds(35);
    expect([readTaking(f.config.dir), exits]).toEqual([null, 0]);
    /* The leader is gone. Its last beats never said that its commits wait for this copy, so this copy may lack
       changes: it asks, and takes nothing by itself. */
    await c.stop();
    await until(() => f.lines.includes('This copy may lack changes; asking the CEO.'));
    expect([readTaking(f.config.dir), exits, sub.did]).toEqual([null, 0, []]);
    /* Its word to the app carries the question while it stands: the leader, and this copy as the one to go on from. */
    await until(() => readKeeperState(f.config.controlDir)?.question != null);
    const question = readKeeperState(f.config.controlDir)!.question!;
    expect(question).toMatchObject({ leader: { networkId: HOST_ID }, copies: [{ networkId: own, self: true, reach: null }], waiting: null });
    expect(question.leader.heard).not.toBeNull();
    /* The CEO chooses to wait: the question says until when, and nothing is taken. */
    const answer = (said: object) => writeFileSync(join(f.config.controlDir, RECOVERY_FILE), JSON.stringify({ id: randomUUID(), by: 'p1', at: new Date().toISOString(), ...said }));
    answer({ wait: true });
    await until(() => readKeeperState(f.config.controlDir)?.question?.waiting != null);
    expect([readTaking(f.config.dir), exits]).toEqual([null, 0]);
    /* The CEO says to go on from this copy: it writes the takeover down, stops its subscription and ends, to start
       again as the keeper that takes the server. From then it tells the others that it is taking it. */
    answer({ goOn: own, reach: null });
    await until(() => exits === 1);
    expect(readTaking(f.config.dir)).toMatchObject({ phase: 'go', kind: 'ceo', from: { networkId: HOST_ID }, generation: 7, w: null, copies: null });
    expect([sub.did, f.keeper.beats().own().stance]).toEqual([['disable'], { kind: 'attempting' }]);
    expect(f.lines.some(line => line.startsWith('Going on from'))).toBe(true);
  });

  it('waits for the update', async () => {
    const dir = folder();
    const c = await company({ dir });
    const clock = { now: 0 };
    /* Its copy holds every table, so its app reads. */
    /* Its front door holds a request for the leader, as every machine's does: what it says while the promise holds,
       it says as it holds one. */
    const f = await follower(c, { ownAppAfterMs: 100, updating: { now: () => clock.now }, worker: { holdMs: 400 } }, own => writeFileSync(join(own, COPY_STATE), JSON.stringify({ attempt: 1, database: 'hornhoof', phase: 'ready' })));
    await until(() => f.keeper.status().leader !== null);
    await until(() => readKeeperState(f.config.controlDir)?.mode === 'read');
    const ports = await f.keeper.peerPorts();
    /* The time the leader names is of its own clock; the copy keeps the promise a quarter of an hour by its own. */
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
    await rounds(20, 20);
    const waiting = await ask(f.ports.front, { path: '/api/tasks' });
    expect([waiting.status, waiting.json()]).toMatchObject([503, { error: { reason: 'maintenance' } }]);
    expect([made(), readKeeperState(f.config.controlDir)?.mode]).toEqual([steps, 'maintenance']);
    /* The promise ran out: the app reads again, and the time with no leader counts from here. */
    clock.now = PROMISE_MS;
    await until(() => readKeeperState(f.config.controlDir)?.mode === 'read');
    expect([readWord(f.config.controlDir), f.lines]).toEqual([null, expect.arrayContaining(["The company server's update promise ran out."])]);
    /* Asked to hold for nothing, so no ask waits out a hold while the rounds stand still. */
    await until(async () => (await ask(f.ports.front, { path: '/tasks', headers: { [HOLD]: '0' } }).catch(() => null))?.body === "the copy's own app: /tasks");
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

/* These two drive the keeper's own intervals on a fake clock. */
describe('the keeper of a machine that keeps a copy, on its own intervals', () => {
  it('keeps its peer tunnel running through one empty settings read, and says why before stopping on a second', async () => {
    const dir = folder();
    const key = machineKey(dir);
    const authority = await makeAuthority('00000000-0000-4000-8000-000000000001');
    const machine = '11111111-0000-4000-8000-000000000002';
    const issued = await issueCertificate(authority, { machineId: machine, role: 'data', signKey: key.publicPem });
    const crlPem = await makeCrl(authority, []);
    writePrivately(join(dir, CERT_FILE), JSON.stringify({ machine, role: 'data', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() }));
    writePrivately(
      join(dir, PEERS_FILE),
      JSON.stringify({
        machine,
        role: 'data',
        authorityPem: authority.certPem,
        revoked: [],
        crlPem,
        data: [],
        link: { name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'relay.hornhoof.test', serverPort: 443, appSecret: 'a'.repeat(32), visitorKey: 'v'.repeat(32), dataSecret: 'd'.repeat(32) },
        copy: null,
      }),
    );

    const realSettings: TunnelSettings = {
      url: 'https://acme.hornhoof.test',
      name: 'acme',
      key: 'k'.repeat(32),
      tunnel: { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' },
      mode: 'http',
    };
    let currentSettings: TunnelSettings | null = realSettings;
    const offered: string[] = [];
    const lines: string[] = [];
    const app = await ownApp();
    const db = await tcpEcho('copy: ');

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const keeper = new FollowKeeper({
      config: {
        machineId: hostIdOf(MAC.machineId),
        joinServer: 'http://127.0.0.1:1',
        ticket: null,
        controlDir: folder(),
        dir,
        commit: 'w0rker',
        ports: { web: 18081, peer: null },
        addresses: ['192.168.1.20'],
        ownerKey: null,
        hostOs: 'linux',
        survivorMs: 600_000,
        secret: Buffer.from(TEST_SECRET, 'base64'),
        databaseUrl: 'postgres://hornhoof@127.0.0.1:1/hornhoof',
      },
      frontHost: null,
      app,
      db,
      sql: emptyCluster().sql,
      settings: async () => currentSettings,
      log: line => lines.push(line),
      host: LOOPBACK,
      doorHost: LOOPBACK,
      allowed: async () => [LOOPBACK],
      ports: { door: 0, peer: 0, peerApp: 0 },
      everyMs: 60_000,
      beatEveryMs: 60_000,
      watcher: { everyMs: 60_000 },
      recovery: { everyMs: 60_000 },
      peerClientFor: (_services, clientId) => (offered.push(clientId), SLEEPER),
      worker: {
        ports: { front: 0 },
        visitClientFor: () => SLEEPER,
        lookEveryMs: 60_000,
        viewEveryMs: 360_000,
        reportEveryMs: 360_000,
        holderEveryMs: 360_000,
        sessions: { everyMs: 60_000, helloMs: 50, connectMs: 1000, directEveryMs: 60_000, pingMs: 60_000 },
        computer: { openEveryMs: 360_000, closedEveryMs: 360_000 },
        internet: { start: () => undefined, stop: () => undefined, snapshot: () => ({ internetRttMs: null, internetMbps: null }) },
      },
    });
    await keeper.start();
    onTestFinished(async () => {
      await keeper.stop();
      vi.useRealTimers();
    });

    const stepUntil = async (stepMs: number, check: () => boolean) => {
      while (!check()) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    await keeper.peerPorts();
    await stepUntil(3_000, () => offered.length === 1);

    /* One empty read six virtual minutes in does not drop the copy's peer tunnel. */
    await vi.advanceTimersByTimeAsync(360_000);
    currentSettings = null;
    await vi.advanceTimersByTimeAsync(3_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    currentSettings = realSettings;
    await vi.advanceTimersByTimeAsync(3_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(offered).toHaveLength(1);
    expect(lines).not.toContain('No public link: this machine is not offered to its peers through it.');

    /* Two empty reads in a row stop the peer tunnel, saying why first. */
    currentSettings = null;
    await stepUntil(3_000, () => lines.includes('No public link: this machine is not offered to its peers through it.'));
    const whyAt = lines.indexOf("Stopping the peer tunnel: this machine's database holds no public link.");
    expect(whyAt).toBeGreaterThanOrEqual(0);
    expect(whyAt).toBeLessThan(lines.indexOf('No public link: this machine is not offered to its peers through it.'));

    await keeper.stop();
    vi.useRealTimers();
  });

  it('stops the visitor tunnel on the first read after the machine is disconnected', async () => {
    const dir = folder();
    const key = machineKey(dir);
    const authority = await makeAuthority('00000000-0000-4000-8000-000000000001');
    const authorityKey = createPrivateKey(authority.keyPem);
    const machine = '11111111-0000-4000-8000-000000000002';
    const issued = await issueCertificate(authority, { machineId: machine, role: 'data', signKey: key.publicPem });
    const crlPem = await makeCrl(authority, []);
    const view = {
      machine,
      role: 'data' as const,
      authorityPem: authority.certPem,
      revoked: [] as string[],
      crlPem,
      data: [{ machine: '22222222-0000-4000-8000-000000000003', networkId: `99bb2233${'2'.repeat(24)}`, hostname: 'leader', addresses: [] as string[], peerPort: null, webPort: null }],
      link: { name: 'acme', url: 'https://acme.hornhoof.test', serverAddr: 'relay.hornhoof.test', serverPort: 443, appSecret: 'a'.repeat(32), visitorKey: 'v'.repeat(32), dataSecret: 'd'.repeat(32) },
      copy: null,
    };
    writePrivately(join(dir, CERT_FILE), JSON.stringify({ machine, role: 'data', certPem: issued.certPem, authorityPem: authority.certPem, until: issued.until.toISOString() }));
    writePrivately(join(dir, PEERS_FILE), JSON.stringify(view));

    let cut = false;
    let visits = 0;
    const lines: string[] = [];
    const clock = { ms: Date.now() };
    const signed = (ask: { machine: string; serial: string; at: string }, payload: string, status: number) =>
      Response.json({ payload, signature: sign(null, Buffer.from(renewedMessage(ask.machine, ask.serial, ask.at, payload)), authorityKey).toString('base64') }, { status });
    const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
      const ask = JSON.parse(String(init?.body)) as { machine: string; serial: string; at: string };
      if (cut) return signed(ask, JSON.stringify({ disconnected: true }), 410);
      return signed(ask, JSON.stringify({ machine, serial: ask.serial, at: ask.at, role: 'data', authorityPem: authority.certPem, certPem: null, until: null, view }), 200);
    }) as typeof fetch;

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const keeper = new FollowKeeper({
      config: {
        machineId: hostIdOf(MAC.machineId),
        joinServer: 'http://127.0.0.1:1',
        ticket: null,
        controlDir: folder(),
        dir,
        commit: 'w0rker',
        ports: { web: 18081, peer: null },
        addresses: ['192.168.1.20'],
        ownerKey: null,
        hostOs: 'linux',
        survivorMs: 600_000,
        secret: Buffer.from(TEST_SECRET, 'base64'),
        databaseUrl: 'postgres://hornhoof@127.0.0.1:1/hornhoof',
      },
      frontHost: null,
      app: await ownApp(),
      db: await tcpEcho('copy: '),
      sql: emptyCluster().sql,
      settings: async () => null,
      log: line => lines.push(line),
      host: LOOPBACK,
      doorHost: LOOPBACK,
      allowed: async () => [LOOPBACK],
      ports: { door: 0, peer: 0, peerApp: 0 },
      everyMs: 60_000,
      beatEveryMs: 60_000,
      watcher: { everyMs: 60_000 },
      recovery: { everyMs: 60_000 },
      peerClientFor: () => SLEEPER,
      worker: {
        ports: { front: 0 },
        now: () => new Date((clock.ms += 100)),
        fetch: fakeFetch,
        visitClientFor: () => (visits++, { program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
        lookEveryMs: 20,
        renewAfterMs: 20,
        renewEveryMs: 20,
        viewEveryMs: 360_000,
        reportEveryMs: 360_000,
        holderEveryMs: 360_000,
        sessions: { everyMs: 60_000, helloMs: 50, connectMs: 1000, directEveryMs: 60_000, pingMs: 60_000 },
        computer: { openEveryMs: 360_000, closedEveryMs: 360_000 },
        internet: { start: () => undefined, stop: () => undefined, snapshot: () => ({ internetRttMs: null, internetMbps: null }) },
      },
    });
    await keeper.start();
    onTestFinished(async () => {
      await keeper.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    const stepUntil = async (stepMs: number, check: () => boolean) => {
      while (!check()) {
        await vi.advanceTimersByTimeAsync(stepMs);
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    await stepUntil(20, () => visits === 1);

    const kill = vi.spyOn(ChildProcess.prototype, 'kill');
    cut = true;
    await stepUntil(20, () => keeper.status().disconnected);
    expect(kill).not.toHaveBeenCalled();

    /* First 3 s read of the visitor tunnel: SIGTERM goes out at once, with no extra read held. */
    await vi.advanceTimersByTimeAsync(3000);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await stateUntil(() => lines.includes('No public link: this machine reaches the company server on its local network only.'));

    await keeper.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
