import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { MachineRole } from '../src/db/schema.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { issueCertificate, makeAuthority, makeCrl, type Authority } from '../src/modules/network/authority.js';
import { LeaderDoor } from '../src/net/leader-door.js';
import { PeerDoor } from '../src/net/peer-door.js';
import { PeerServer, type Peer } from '../src/net/peer-server.js';
import { PeerSessions, type DialTarget, type PeerSessionsOptions } from '../src/net/peer-sessions.js';
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
async function standUp(as: { id?: string; role?: MachineRole } = {}) {
  const authority = await makeAuthority(COMPANY);
  const server = await machineOf(authority, as.id ?? SERVER_ID, as.role ?? 'data');
  const worker = await machineOf(authority, WORKER_ID, 'worker');
  const state = { lead: true, hellos: 0, crl: await makeCrl(authority, []), revoked: new Set<string>() };
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
    db: null,
    hello: (peer: Peer) => (state.hellos++, { machine: server.id, role: server.role, lead: state.lead, commit: 'c0ffee', asked: peer.machine }),
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
      pingMs: 50,
      ...over,
    });
    onTestFinished(() => sessions.close());
    return sessions;
  };
  return { authority, server, worker, state, peers, peerPort, appPort, target, sessionsWith, lines, said, sockets };
}

type Echo = { method: string; url: string; headers: Record<string, string>; length: number; sha256: string };

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
    expect(sessions.leader()).toEqual({ machine: SERVER_ID, path: 'direct', hello: { machine: SERVER_ID, role: 'data', lead: true, commit: 'c0ffee', seen: '127.0.0.1' } });
    expect(sessions.seen()).toEqual(['127.0.0.1']);
    expect(sessions.state()).toEqual({ path: 'direct', directFails: false, refused: false });
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

  it('closes a connection it cannot carry to a leader', async () => {
    const { sessions, port } = await withDoor();
    sessions.use([]);
    const error = await ask(port, { path: '/api/health' }).then(() => null, (err: NodeJS.ErrnoException) => err.code ?? 'closed');
    expect(error).not.toBeNull();
    await expect(sessions.connectApp()).rejects.toThrow('No leader of the company is in reach.');
  });
});
