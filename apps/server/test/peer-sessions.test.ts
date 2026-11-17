import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { Readable, type Duplex } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import tls from 'node:tls';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { PeerBackups } from '../src/modules/keeper/backups.js';
import type { MachineRole } from '../src/db/schema.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { issueCertificate, makeAuthority, makeCrl, type Authority } from '../src/modules/network/authority.js';
import { LeaderDoor } from '../src/net/leader-door.js';
import { PeerDoor } from '../src/net/peer-door.js';
import { PeerServer, type Peer, type PeerSwitches } from '../src/net/peer-server.js';
import { highestLead, PeerSessions, type DialTarget, type Hello, type PeerSessionsOptions } from '../src/net/peer-sessions.js';
import { until } from './helpers.js';

const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000a';
const SERVER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WORKER_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const OTHER_ID = 'cccccccc-0000-4000-8000-00000000000c';
const SERVER_NETWORK_ID = `77aa0011${'1'.repeat(56)}`;
/* An address of the documentation range, where nothing answers. */
const NOWHERE = '192.0.2.1';
const MiB = 1024 * 1024;

type Machine = { id: string; role: MachineRole; key: MachineKey; certPem: string; serial: string; until: Date };

function ed25519Key(): MachineKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { privatePem: privateKey, publicPem: publicKey };
}

async function machineOf(authority: Authority, id: string, role: MachineRole): Promise<Machine> {
  const key = ed25519Key();
  const issued = await issueCertificate(authority, { machineId: id, role, signKey: key.publicPem });
  return { id, role, key, certPem: issued.certPem, serial: issued.serial, until: issued.until };
}

const heldOf = (machine: Machine, authority: Authority): HeldCertificate => ({ machine: machine.id, role: machine.role, certPem: machine.certPem, authorityPem: authority.certPem, until: machine.until.toISOString() });

/* The leader's app: it says what it was asked, and how much of a body reached it. */
async function echoApp() {
  const server = http.createServer((req, res) => {
    const hash = createHash('sha256');
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      length += chunk.length;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, length, sha256: hash.digest('hex') }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    server.closeAllConnections();
    server.close();
  });
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

/* A data machine's peer link as its keeper serves it, and a worker of the same company with its certificate. */
async function standUp(as: { id?: string; role?: MachineRole; backups?: PeerBackups; db?: { host: string; port: number }; switches?: PeerSwitches; dialer?: MachineRole } = {}) {
  const authority = await makeAuthority(COMPANY);
  const server = await machineOf(authority, as.id ?? SERVER_ID, as.role ?? 'data');
  const worker = await machineOf(authority, WORKER_ID, as.dialer ?? 'worker');
  const state = { lead: true as boolean | string, hellos: 0, crl: await makeCrl(authority, []), revoked: new Set<string>() };
  const door = new PeerDoor({ app: await echoApp() });
  await door.start();
  onTestFinished(() => door.stop());
  const lines: string[] = [];
  const peers = new PeerServer({
    held: () => heldOf(server, authority),
    key: server.key,
    crl: () => state.crl,
    revoked: () => state.revoked,
    door,
    db: as.db ?? null,
    hello: (peer: Peer) => (state.hellos++, { machine: server.id, role: server.role, lead: state.lead, commit: 'c0ffee', asked: peer.machine, term: { number: 7, machine: SERVER_NETWORK_ID, split: false }, sync: OTHER_ID, moving: null }),
    backups: as.backups,
    switches: as.switches,
    log: line => lines.push(line),
  });
  onTestFinished(() => peers.close());
  /* Every connection the worker's side opens from here on, tried or made. */
  const dialed = vi.spyOn(tls, 'connect');
  onTestFinished(() => dialed.mockRestore());
  const before = dialed.mock.results.length;
  const sockets = (): tls.TLSSocket[] => dialed.mock.results.slice(before).map(result => result.value as tls.TLSSocket);
  const peerPort = await peers.listen(0, 'peer', '127.0.0.1');
  const appPort = await peers.listen(0, 'app', '127.0.0.1');
  const target = (over: Partial<DialTarget> = {}): DialTarget => ({ machine: SERVER_ID, networkId: SERVER_NETWORK_ID, addresses: ['127.0.0.1'], peerPort, relayPort: null, ...over });
  /* The worker's side. Every pace is short, so a test never waits for a real one. */
  const said: string[] = [];
  const sessionsWith = (over: Partial<PeerSessionsOptions> = {}): PeerSessions => {
    const sessions = new PeerSessions({
      held: () => heldOf(worker, authority),
      key: worker.key,
      revoked: () => new Set<string>(),
      own: () => [],
      log: line => said.push(line),
      connectMs: 2000,
      everyMs: 10,
      helloMs: 10,
      directEveryMs: 10,
      pingMs: 60_000,
      ...over,
    });
    onTestFinished(() => sessions.close());
    return sessions;
  };
  return { authority, server, worker, state, peers, peerPort, appPort, target, sessionsWith, lines, said, sockets };
}

type Echo = { method: string; url: string; headers: Record<string, string>; length: number; sha256: string };

/* A machine's database, for these tests: it sends back what it gets, with its own word first. */
async function tcpEcho(word: string): Promise<{ host: string; port: number }> {
  const server = net.createServer(socket => {
    socket.on('error', () => undefined);
    socket.on('data', chunk => socket.write(word + String(chunk)));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => void server.close());
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

function ask(port: number, options: http.RequestOptions = {}, body?: Buffer): Promise<{ status: number; echo: Echo }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, ...options }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, echo: JSON.parse(Buffer.concat(chunks).toString()) as Echo }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const refused = (port: number): Promise<string> =>
  new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve('connected')));
    socket.once('error', (err: NodeJS.ErrnoException) => resolve(String(err.code)));
  });

describe("a worker's sessions to the company's data machines", () => {
  it('reaches the leader directly', async () => {
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    expect(sessions.leader()).toBeNull();
    expect(sessions.state()).toEqual({ path: null, directFails: false, refused: false });
    sessions.use([stand.target()]);
    await until(() => sessions.leader() !== null);
    expect(sessions.leader()).toEqual({ machine: SERVER_ID, path: 'direct', hello: { machine: SERVER_ID, role: 'data', lead: true, commit: 'c0ffee', seen: '127.0.0.1', term: { number: 7, machine: SERVER_NETWORK_ID, split: false }, sync: OTHER_ID, moving: null } });
    expect(sessions.seen()).toEqual(['127.0.0.1']);
    expect(sessions.state()).toEqual({ path: 'direct', directFails: false, refused: false });
  });

  it('counts the bytes that come on a session, the answers to its hellos among them, as its silence is told by them', async () => {
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => sessions.leader() !== null);
    const session = sessions['kept'][0]!.session!;
    const before = session.read();
    const hellos = stand.state.hellos;
    await until(() => stand.state.hellos > hellos + 2);
    expect(session.read()).toBeGreaterThan(before);
  });

  it('times its hellos to the leader', async () => {
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    /* With no leader there is no round trip to speak of. */
    expect(sessions.linkRttMs()).toBeNull();
    sessions.use([stand.target()]);
    await until(() => sessions.linkRttMs() !== null);
    const first = sessions.linkRttMs()!;
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(2000);
    /* The day's median is asked at a time: a day and more on, today's hellos are no part of it. */
    expect(sessions.linkRttMs(Date.now() + 2 * 86_400_000)).toBeNull();
    /* A leader that stops leading is no leader to measure against. */
    stand.state.lead = false;
    await until(() => sessions.leader() === null);
    expect(sessions.linkRttMs()).toBeNull();
  });

  it('forgets what a session that ended saw', async () => {
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => sessions.seen().length === 1);
    expect(sessions.seen()).toEqual(['127.0.0.1']);
    /* The data machine is listed no more: its session ends, and the address it saw goes with it. */
    sessions.use([]);
    await until(() => sessions.seen().length === 0);
    expect(sessions.leader()).toBeNull();
    /* A new session says what it sees anew. */
    sessions.use([stand.target()]);
    await until(() => sessions.seen().length === 1);
  });

  it('takes the relay when direct does not answer, and says so only for an address on its own network', async () => {
    const stand = await standUp();
    /* The relay's local port leads to the server's app door, as the visitor frpc's does. */
    const target = stand.target({ addresses: [NOWHERE], relayPort: stand.appPort });
    const near = stand.sessionsWith({ connectMs: 200, own: () => ['192.0.2.9'], directEveryMs: 60_000 });
    near.use([target]);
    await until(() => near.leader() !== null);
    expect(near.leader()!.path).toBe('relay');
    expect(near.state()).toEqual({ path: 'relay', directFails: true, refused: false });

    /* A worker in another home shares no network with the server, so nothing there refuses it. */
    const far = stand.sessionsWith({ connectMs: 200, own: () => ['198.51.100.9'], directEveryMs: 60_000 });
    far.use([target]);
    await until(() => far.leader() !== null);
    expect(far.state()).toEqual({ path: 'relay', directFails: false, refused: false });
  });

  it('goes back to the direct path once an address answers', async () => {
    const stand = await standUp();
    const sessions = stand.sessionsWith({ connectMs: 200, own: () => ['192.0.2.9'] });
    sessions.use([stand.target({ addresses: [NOWHERE], relayPort: stand.appPort })]);
    await until(() => sessions.leader()?.path === 'relay');
    /* The server's keeper reported another address. */
    sessions.use([stand.target({ addresses: [NOWHERE, '127.0.0.1'], relayPort: stand.appPort })]);
    await until(() => sessions.leader()?.path === 'direct');
    expect(sessions.state()).toEqual({ path: 'direct', directFails: false, refused: false });
  });

  it('trusts only the data machine it dialed', async () => {
    /* The certificate is the authority's, but of another machine than the one the view named. */
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target({ machine: OTHER_ID })]);
    await until(() => stand.sockets().length >= 3);
    expect(sessions.leader()).toBeNull();
    expect(stand.state.hellos).toBe(0);

    /* A worker of the company is no data machine, whatever it answers. */
    const asWorker = await standUp({ role: 'worker' });
    const toWorker = asWorker.sessionsWith();
    toWorker.use([asWorker.target()]);
    await until(() => asWorker.sockets().length >= 3);
    expect(toWorker.leader()).toBeNull();
    expect(asWorker.state.hellos).toBe(0);

    /* A data machine that was cut off since. */
    const cut = await standUp();
    const toCut = cut.sessionsWith({ revoked: () => new Set([cut.server.serial]) });
    toCut.use([cut.target()]);
    await until(() => cut.sockets().length >= 3);
    expect(toCut.leader()).toBeNull();
    expect(toCut.state()).toEqual({ path: null, directFails: false, refused: false });
    expect(cut.state.hellos).toBe(0);
  });

  it("streams a bundle over the leader's session", async () => {
    const [BUNDLE, REFUSED, STALLS] = ['0f0f0f0f-0000-4000-8000-0000000000a1', '0f0f0f0f-0000-4000-8000-0000000000a2', '0f0f0f0f-0000-4000-8000-0000000000a3'];
    const bytes = randomBytes(5 * MiB);
    const taken: { peer: string; id: string; sha256: string }[] = [];
    const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
    const backups: PeerBackups = {
      get: (_peer, id) => {
        if (id === BUNDLE) return { status: 200, length: bytes.length, stream: () => Readable.from([bytes.subarray(0, MiB), bytes.subarray(MiB)]) };
        /* The first bytes come, and then no more. */
        if (id === STALLS) {
          let first = true;
          return { status: 200, length: bytes.length, stream: () => new Readable({ read() { if (first) this.push(bytes.subarray(0, 1024)); first = false; } }) };
        }
        return { status: 404 };
      },
      put: async (peer, id, body) => {
        if (id === REFUSED) return 403;
        taken.push({ peer: peer.machine, id, sha256: sha256(await buffer(body)) });
        return 201;
      },
    };
    const stand = await standUp({ backups });
    const sessions = stand.sessionsWith({ streamIdleMs: 300 });
    /* Without a leader there is nobody to ask. */
    await expect(sessions.stream('GET', `/peer/backups/${BUNDLE}`)).rejects.toThrow('No leader of the company is in reach.');
    sessions.use([stand.target()]);
    await until(() => sessions.leader() !== null);

    const got = await sessions.stream('GET', `/peer/backups/${BUNDLE}`);
    expect([got.status, got.length]).toEqual([200, bytes.length]);
    expect(sha256(await buffer(got.body))).toBe(sha256(bytes));
    const none = await sessions.stream('GET', `/peer/backups/${REFUSED}`);
    expect([none.status, none.length]).toEqual([404, null]);
    none.body.destroy();

    const sent = await sessions.stream('PUT', `/peer/backups/${BUNDLE}`, Readable.from([bytes.subarray(0, 2 * MiB), bytes.subarray(2 * MiB)]));
    expect(sent.status).toBe(201);
    sent.body.destroy();
    expect(taken).toEqual([{ peer: WORKER_ID, id: BUNDLE, sha256: sha256(bytes) }]);
    /* One that is refused is answered at once, and what was being sent is let go of. */
    const source = Readable.from((async function* () { for (let sentMiB = 0; sentMiB < 64; sentMiB += 1) yield bytes.subarray(0, MiB); })());
    const refusedPut = await sessions.stream('PUT', `/peer/backups/${REFUSED}`, source);
    expect(refusedPut.status).toBe(403);
    refusedPut.body.destroy();
    await until(() => source.destroyed);

    /* A stream on which nothing moves is cut, with an error for whoever reads it. */
    const stalled = await sessions.stream('GET', `/peer/backups/${STALLS}`);
    await expect(buffer(stalled.body)).rejects.toThrow('stopped moving');
    /* And the session is as good as before. */
    expect((await sessions.stream('GET', `/peer/backups/${BUNDLE}`)).status).toBe(200);
  });

  it("reaches a data machine's db", async () => {
    const leaderDb = await tcpEcho('leader: ');
    const copyDb = await tcpEcho('copy: ');
    const stand = await standUp({ db: leaderDb });
    /* A second data machine of the same company, which does not lead. */
    const copy = await machineOf(stand.authority, OTHER_ID, 'data');
    const copyDoor = new PeerDoor({ app: await echoApp() });
    await copyDoor.start();
    onTestFinished(() => copyDoor.stop());
    const copyPeers = new PeerServer({
      held: () => heldOf(copy, stand.authority), key: copy.key, crl: () => stand.state.crl, revoked: () => stand.state.revoked, door: copyDoor, db: copyDb,
      hello: () => ({ machine: copy.id, role: 'data', lead: false, commit: 'c0ffee' }), log: () => undefined,
    });
    onTestFinished(() => copyPeers.close());
    const copyPort = await copyPeers.listen(0, 'peer', '127.0.0.1');
    const targets = [stand.target(), stand.target({ machine: OTHER_ID, peerPort: copyPort })];
    const said = async (stream: Duplex, text: string): Promise<string> => {
      stream.write(text);
      const [chunk] = (await once(stream, 'data')) as [Buffer];
      stream.destroy();
      return String(chunk);
    };

    /* A machine that keeps data: the leader's database when it names none, else the one it names. */
    const data = await machineOf(stand.authority, 'dddddddd-0000-4000-8000-00000000000d', 'data');
    const sessions = stand.sessionsWith({ held: () => heldOf(data, stand.authority), key: data.key });
    sessions.use(targets);
    await until(() => sessions.leader() !== null && sessions.reaches(OTHER_ID));
    expect(await said(await sessions.connectDb(), 'ping')).toBe('leader: ping');
    expect(await said(await sessions.connectDb(OTHER_ID), 'ping')).toBe('copy: ping');
    await expect(sessions.connectDb(WORKER_ID)).rejects.toThrow('No session to that machine.');

    /* A worker's certificate opens no database. */
    const worker = stand.sessionsWith();
    worker.use(targets);
    await until(() => worker.leader() !== null);
    await expect(worker.connectDb()).rejects.toThrow('The machine did not open its database: 403.');
  });

  it('follows what the hello says of who leads', async () => {
    const stand = await standUp();
    stand.state.lead = false;
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => stand.state.hellos >= 3);
    expect(sessions.leader()).toBeNull();
    /* It has a session, though nobody leads. */
    expect(sessions.state().path).toBe('direct');
    stand.state.lead = true;
    await until(() => sessions.leader() !== null);
    stand.state.lead = false;
    await until(() => sessions.leader() === null);
  });

  it('takes the leader with the highest term', async () => {
    const hello = (machine: string, lead: boolean, term: Hello['term']): { hello: Hello } => ({ hello: { machine, role: 'data', lead, commit: 'c0ffee', seen: '127.0.0.1', term } });
    const a = hello(SERVER_ID, true, { number: 3, machine: 'a'.repeat(32), split: false });
    const b = hello(OTHER_ID, true, { number: 4, machine: 'b'.repeat(32), split: false });
    expect(highestLead([a, b])).toBe(b);
    expect(highestLead([b, a])).toBe(b);
    /* One that names no term, as a keeper from before terms were said, counts below every term. */
    expect(highestLead([a, hello(OTHER_ID, true, undefined)])).toBe(a);
    expect(highestLead([hello(OTHER_ID, true, null), a])).toBe(a);
    /* At the same number, the machine decides; one that does not lead is nobody's leader. */
    const c = hello(WORKER_ID, true, { number: 4, machine: 'c'.repeat(32), split: false });
    expect(highestLead([b, c])).toBe(c);
    expect(highestLead([hello(OTHER_ID, false, { number: 9, machine: 'b'.repeat(32), split: false }), a])).toBe(a);
    expect(highestLead([hello(OTHER_ID, false, null)])).toBeUndefined();
    /* The hello's words on the term, the copy commits wait for and a move under way come through as they were said. */
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => sessions.leader() !== null);
    expect(sessions.leader()!.hello).toMatchObject({ term: { number: 7, machine: SERVER_NETWORK_ID, split: false }, sync: OTHER_ID, moving: null });
  });

  it('loses the leader when its session ends', async () => {
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => sessions.leader() !== null);
    const first = stand.sockets();
    await stand.peers.close();
    await until(() => sessions.leader() === null);
    await until(() => sessions.state().path === null && first.every(socket => socket.destroyed));
  });

  it('tells when the data machine refuses its certificate', async () => {
    const stand = await standUp();
    stand.state.crl = await makeCrl(stand.authority, [stand.worker.serial]);
    stand.peers.refresh();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => sessions.state().refused);
    expect(sessions.leader()).toBeNull();
    /* With a certificate the server takes, the refusal is over. */
    stand.state.crl = await makeCrl(stand.authority, []);
    stand.peers.refresh();
    await until(() => sessions.leader() !== null);
    expect(sessions.state().refused).toBe(false);
  });

  it('takes a data machine that answers oddly for no refusal', async () => {
    const stand = await standUp();
    /* A hello of a shape this build does not read, as a machine of another version might give. */
    stand.state.lead = 'yes';
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => stand.state.hellos >= 3);
    expect(sessions.leader()).toBeNull();
    expect(sessions.state()).toEqual({ path: null, directFails: false, refused: false });
    expect(stand.said).toEqual([]);
  });

  it("dials all of a machine's addresses at once, so one that is silent holds nothing up", async () => {
    const stand = await standUp();
    /* With all the patience in the world for each address: one after another, the second would never be tried. */
    const sessions = stand.sessionsWith({ connectMs: 3_600_000 });
    sessions.use([stand.target({ addresses: ['192.0.2.1', '192.0.2.2', '127.0.0.1'] })]);
    await until(() => sessions.leader() !== null);
    expect(sessions.leader()!.path).toBe('direct');
  });

  it('lets what the relay session carries end by itself when a direct one takes its place', async () => {
    const stand = await standUp();
    /* A hello is on its way nearly all the time, so one is cut by the change of sessions. */
    const sessions = stand.sessionsWith({ connectMs: 200, helloMs: 1 });
    sessions.use([stand.target({ addresses: [NOWHERE], relayPort: stand.appPort })]);
    await until(() => sessions.leader()?.path === 'relay');
    const carried = await sessions.connectApp();
    sessions.use([stand.target({ addresses: ['127.0.0.1'], relayPort: stand.appPort })]);
    await until(() => sessions.leader()?.path === 'direct');
    /* A request on the stream opened before still gets its answer. */
    const chunks: Buffer[] = [];
    carried.on('data', (chunk: Buffer) => chunks.push(chunk));
    carried.write(Buffer.from('GET /api/still HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n'));
    await until(() => Buffer.concat(chunks).toString().includes('/api/still'));
    expect(Buffer.concat(chunks).toString()).toMatch(/^HTTP\/1\.1 200 /);
  });

  it('asks a data machine on its own session', async () => {
    const asked: unknown[] = [];
    const stand = await standUp({
      dialer: 'data',
      switches: {
        handle: (peer, method, path, body) => {
          asked.push([peer.machine, method, path, body]);
          return path.endsWith('/never') ? new Promise(() => {}) : Promise.resolve({ status: 200, body: { machine: SERVER_ID, got: body ?? null } });
        },
      },
    });
    const sessions = stand.sessionsWith();
    const other = `88bb0022${'2'.repeat(56)}`;
    /* Another data machine is listed too, and nothing answers at its address. */
    sessions.use([stand.target({ machine: 'cccccccc-0000-4000-8000-00000000000c', networkId: other, addresses: [NOWHERE] }), stand.target()]);
    await until(() => sessions.reaches(SERVER_ID));
    expect(await sessions.ask(SERVER_NETWORK_ID, 'POST', '/peer/switch/offer', { a: 1 })).toEqual({ status: 200, body: { machine: SERVER_ID, got: { a: 1 } } });
    expect(await sessions.ask(SERVER_NETWORK_ID, 'GET', '/peer/switch/state?switch=x')).toEqual({ status: 200, body: { machine: SERVER_ID, got: null } });
    expect(asked).toEqual([[WORKER_ID, 'POST', '/peer/switch/offer', { a: 1 }], [WORKER_ID, 'GET', '/peer/switch/state?switch=x', undefined]]);
    /* With no session to the machine, or to none of that id, the answer is none at once. */
    const started = performance.now();
    expect(await sessions.ask(other, 'POST', '/peer/switch/offer', {})).toBeNull();
    expect(await sessions.ask('e'.repeat(64), 'POST', '/peer/switch/offer', {})).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    /* A machine that never answers, and an answer that is no JSON, are none too. */
    expect(await sessions.ask(SERVER_NETWORK_ID, 'GET', '/peer/switch/never', undefined, 100)).toBeNull();
    expect(await sessions.ask(SERVER_NETWORK_ID, 'GET', '/peer/nothing')).toBeNull();
    /* The session itself goes on. */
    expect(await sessions.ask(SERVER_NETWORK_ID, 'POST', '/peer/switch/go', { b: 2 })).toMatchObject({ status: 200 });
  });

  it('dials nobody without a certificate, and lets go of a machine it is no longer told', async () => {
    const stand = await standUp();
    let held: HeldCertificate | null = null;
    const sessions = stand.sessionsWith({ held: () => held });
    sessions.use([stand.target()]);
    await new Promise(resolve => setImmediate(resolve));
    expect(stand.sockets()).toHaveLength(0);
    held = heldOf(stand.worker, stand.authority);
    await until(() => sessions.leader() !== null);
    sessions.use([]);
    expect(sessions.leader()).toBeNull();
    await until(() => stand.sockets().every(socket => socket.destroyed));
  });
});

describe("the door to the leader's app", () => {
  async function withDoor() {
    const stand = await standUp();
    const sessions = stand.sessionsWith();
    sessions.use([stand.target()]);
    await until(() => sessions.leader() !== null);
    const door = new LeaderDoor({ connect: () => sessions.connectApp() });
    onTestFinished(() => door.stop());
    const port = await door.start();
    return { stand, sessions, door, port };
  }

  it("passes a request to the leader's app under the worker's name, with its whole body", async () => {
    const { port } = await withDoor();
    const got = await ask(port, { path: '/api/health?x=1' });
    expect(got.status).toBe(200);
    expect(got.echo).toMatchObject({ method: 'GET', url: '/api/health?x=1', length: 0 });
    expect(got.echo.headers['x-hornhoof-via']).toBe(WORKER_ID);

    const body = randomBytes(3 * MiB);
    const posted = await ask(port, { method: 'POST', path: '/api/upload', headers: { 'content-type': 'application/octet-stream', 'content-length': body.length } }, body);
    expect(posted.echo).toMatchObject({ method: 'POST', url: '/api/upload', length: body.length, sha256: createHash('sha256').update(body).digest('hex') });
    /* Many at once, each on a stream of its own. */
    const many = await Promise.all(Array.from({ length: 20 }, (_, i) => ask(port, { path: `/api/n/${i}` })));
    expect(many.map(one => one.echo.url)).toEqual(Array.from({ length: 20 }, (_, i) => `/api/n/${i}`));
  });

  it("marks the keeper's own requests, and no other", async () => {
    const { port } = await withDoor();
    const own = await ask(port, { path: '/api/network/peers', headers: { 'x-hornhoof-via': 'keeper' } });
    expect(own.echo.headers).toMatchObject({ 'x-hornhoof-via': WORKER_ID, 'x-hornhoof-keeper': '1' });
    const visitor = await ask(port, { path: '/api/network/peers', headers: { 'x-hornhoof-keeper': '1' } });
    expect(visitor.echo.headers['x-hornhoof-via']).toBe(WORKER_ID);
    expect(visitor.echo.headers).not.toHaveProperty('x-hornhoof-keeper');
  });

  it('takes connections only while it is open, at the same port', async () => {
    const { door, port } = await withDoor();
    await door.shut();
    expect(await refused(port)).toBe('ECONNREFUSED');
    await door.shut();
    await door.open();
    await door.open();
    expect((await ask(port, { path: '/api/health' })).status).toBe(200);
  });

  it('lets go of what it carries when it shuts, and opens again at once', async () => {
    const { door, port } = await withDoor();
    /* A connection that never ends by itself, as a node's WebSocket is. */
    const open = net.connect(port, '127.0.0.1');
    /* It may end with a reset, which is an end like any other here. */
    open.on('error', () => undefined);
    await new Promise(resolve => open.once('connect', resolve));
    const gone = new Promise(resolve => open.once('close', resolve));
    await door.shut();
    await gone;
    await door.open();
    expect((await ask(port, { path: '/api/health' })).status).toBe(200);
  });

  it('takes another port when its own was taken meanwhile', async () => {
    const { door, port } = await withDoor();
    await door.shut();
    const squatter = net.createServer();
    await new Promise<void>(resolve => squatter.listen(port, '127.0.0.1', resolve));
    onTestFinished(() => void squatter.close());
    await door.open();
    expect(door.port()).not.toBe(port);
    expect((await ask(door.port(), { path: '/api/health' })).status).toBe(200);
  });

  it('closes a connection it cannot carry to a leader', async () => {
    const { sessions, port } = await withDoor();
    sessions.use([]);
    const error = await ask(port, { path: '/api/health' }).then(() => null, (err: NodeJS.ErrnoException) => err.code ?? 'closed');
    expect(error).not.toBeNull();
    await expect(sessions.connectApp()).rejects.toThrow('No leader of the company is in reach.');
  });
});
