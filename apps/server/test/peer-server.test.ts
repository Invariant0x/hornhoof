import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import * as age from 'age-encryption';
import http from 'node:http';
import http2 from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream, Http2SecureServer } from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import { PassThrough, Readable, type Duplex } from 'node:stream';
import tls from 'node:tls';
import * as peculiar from '@peculiar/x509';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { headLine, sealBundle } from '../src/modules/backups/bundle.js';
import type { MakerView } from '../src/modules/backups/types.js';
import { BackupKeeper, type PeerBackups } from '../src/modules/keeper/backups.js';
import { LOAD_FILE, UPLOADS_DIR, UploadTaker } from '../src/modules/keeper/uploads.js';
import type { HeldCertificate } from '../src/modules/keeper/certificate.js';
import type { MachineKey } from '../src/modules/keeper/machine-keys.js';
import { issueCertificate, makeAuthority, makeCrl } from '../src/modules/network/authority.js';
import type { MachineRole } from '../src/db/schema.js';
import type { Authority } from '../src/modules/network/authority.js';
import { VIA } from '../src/modules/network/via.js';
import { PeerDoor, peerHeaders } from '../src/net/peer-door.js';
import {
  APP_AUTHORITY,
  cutOnceAnswered,
  DB_AUTHORITY,
  OncePerMinute,
  PEER_PATHS,
  PeerServer,
  refusalOf,
  routeOf,
  type Peer,
  type PeerServerOptions,
} from '../src/net/peer-server.js';
import type { Target } from '../src/net/proxy.js';
import { until } from './helpers-basic.js';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const COMPANY = '0f0f0f0f-0000-4000-8000-00000000000a';
const OTHER_COMPANY = '0f0f0f0f-0000-4000-8000-00000000000b';
const OWN_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const WORKER_ID = 'bbbbbbbb-0000-4000-8000-00000000000b';
const DATA_ID = 'cccccccc-0000-4000-8000-00000000000c';
const LISTED_ID = 'dddddddd-0000-4000-8000-00000000000d';
const INVOCATION = '3f2b8c1e-7a4d-4e6f-9b10-5c2d8e7f1a23';
const HELLO = { ':path': PEER_PATHS.hello };
const CONNECT_APP = { ':method': 'CONNECT', ':authority': APP_AUTHORITY };
const CONNECT_DB = { ':method': 'CONNECT', ':authority': DB_AUTHORITY };

type Machine = { id: string; role: MachineRole; key: MachineKey; certPem: string; serial: string; until: Date };
type Listening = { target: Target; connections: () => number; sockets: net.Socket[] };
type Door = { port: number; tls: Http2SecureServer };
type Stand = Awaited<ReturnType<typeof standUp>>;

const ignore = (): void => {};

/* A promise to settle from outside, since Promise.withResolvers is newer than the language level the tests compile to. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function ed25519Key(): MachineKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

async function machineOf(authority: Authority, id: string, role: MachineRole, now?: Date): Promise<Machine> {
  const key = ed25519Key();
  const issued = await issueCertificate(authority, { machineId: id, role, signKey: key.publicPem, now });
  return { id, role, key, certPem: issued.certPem, serial: issued.serial, until: issued.until };
}

function heldOf(machine: Machine, authority: Authority): HeldCertificate {
  return {
    machine: machine.id,
    role: machine.role,
    certPem: machine.certPem,
    authorityPem: authority.certPem,
    until: machine.until.toISOString(),
  };
}

/* The authority's own signature on a certificate that names no machine, which only the second guard can tell apart. */
async function namelessUnder(authority: Authority): Promise<Machine> {
  const key = ed25519Key();
  const publicKey = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(key.publicPem.replace(/-----[^-]+-----|\s/g, ''), 'base64'),
    'Ed25519',
    true,
    ['verify'],
  );
  const until = new Date(Date.now() + DAY_MS);
  const cert = await peculiar.X509CertificateGenerator.create({
    serialNumber: '7a7a7a7a',
    subject: 'CN=nameless',
    issuer: new peculiar.X509Certificate(authority.certPem).subjectName,
    notBefore: new Date(Date.now() - DAY_MS),
    notAfter: until,
    publicKey,
    signingKey: createPrivateKey(authority.keyPem).toCryptoKey('Ed25519', false, ['sign']),
    signingAlgorithm: { name: 'Ed25519' },
  });
  return { id: 'nameless', role: 'worker', key, certPem: cert.toString('pem'), serial: '7a7a7a7a', until };
}

/* A server on a free port, taken down with every socket it has, upgraded ones too, when the test ends. */
async function listening(server: net.Server): Promise<Listening> {
  const sockets: net.Socket[] = [];
  server.on('connection', socket => sockets.push(socket));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>(resolve => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { target: { host: '127.0.0.1', port }, connections: () => sockets.length, sockets };
}

/* The app: it says what it was asked, and a WebSocket answers each message under the name the door gave the peer. */
function echoApp(): Promise<Listening> {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    sockets.handleUpgrade(req, socket, head, ws => {
      ws.on('message', message => ws.send(`${String(req.headers[VIA])}: ${String(message)}`));
    });
  });
  return listening(server);
}

function tcpEcho(): Promise<Listening> {
  return listening(
    net.createServer(socket => {
      socket.on('error', ignore);
      socket.pipe(socket);
    }),
  );
}

async function standUp(overrides: Partial<PeerServerOptions> = {}) {
  const authority = await makeAuthority(COMPANY);
  const own = await machineOf(authority, OWN_ID, 'data');
  const listed = await machineOf(authority, LISTED_ID, 'worker');
  const worker = await machineOf(authority, WORKER_ID, 'worker');
  const data = await machineOf(authority, DATA_ID, 'data');
  const state = {
    held: heldOf(own, authority) as HeldCertificate | null,
    crl: (await makeCrl(authority, [listed.serial])) as string | null,
    revoked: new Set([listed.serial]),
    now: new Date(),
  };
  const app = await echoApp();
  const db = await tcpEcho();
  const peerDoor = new PeerDoor({ app: app.target });
  await peerDoor.start();
  onTestFinished(() => peerDoor.stop());
  const lines: string[] = [];
  const server = new PeerServer({
    held: () => state.held,
    key: own.key,
    crl: () => state.crl,
    revoked: () => state.revoked,
    door: peerDoor,
    db: db.target,
    hello: peer => ({ machine: peer.machine, role: peer.role }),
    log: line => lines.push(line),
    now: () => state.now,
    ...overrides,
  });
  onTestFinished(() => server.close());
  const created = vi.spyOn(http2, 'createSecureServer');
  onTestFinished(() => created.mockRestore());
  const open = async (kind: 'peer' | 'app'): Promise<Door> => {
    const port = await server.listen(0, kind, '127.0.0.1');
    return { port, tls: created.mock.results.at(-1)!.value as Http2SecureServer };
  };
  return { authority, own, listed, worker, data, state, app, db, peerDoor, lines, server, open };
}

function clientOf(stand: Stand, port: number, machine?: Machine, more: http2.SecureClientSessionOptions = {}): ClientHttp2Session {
  const session = http2.connect(`https://127.0.0.1:${port}`, {
    ca: stand.authority.certPem,
    checkServerIdentity: () => undefined,
    ...(machine ? { cert: machine.certPem, key: machine.key.privatePem } : {}),
    ...more,
  });
  session.on('error', ignore);
  onTestFinished(() => void session.destroy());
  return session;
}

/* The status the server answered with, or null when the stream ended without an answer. */
function statusOf(stream: ClientHttp2Stream): Promise<number | null> {
  return new Promise(resolve => {
    stream.on('error', ignore);
    stream.once('response', headers => resolve(Number(headers[':status'])));
    stream.once('close', () => resolve(null));
  });
}

async function textOf(stream: Readable): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

/* Not events.once, which rejects on an error, and a refused client's socket may well have one on its way out. */
/* One that closed before anyone asked has no event left to give. */
function closeOf(emitter: NodeJS.EventEmitter): Promise<void> {
  if ((emitter as { closed?: boolean }).closed === true) return Promise.resolve();
  return new Promise(resolve => emitter.once('close', () => resolve()));
}

function watched(server: Http2SecureServer): { refused: () => number; secure: () => number; sessions: () => number } {
  const count = { refused: 0, secure: 0, sessions: 0 };
  server.on('tlsClientError', () => void (count.refused += 1));
  server.on('secureConnection', () => void (count.secure += 1));
  server.on('session', () => void (count.sessions += 1));
  return { refused: () => count.refused, secure: () => count.secure, sessions: () => count.sessions };
}

function tlsClientOf(stand: Stand, port: number, machine: Machine, more: tls.ConnectionOptions = {}): tls.TLSSocket {
  const socket = tls.connect({
    host: '127.0.0.1',
    port,
    ca: stand.authority.certPem,
    cert: machine.certPem,
    key: machine.key.privatePem,
    ALPNProtocols: ['h2'],
    checkServerIdentity: () => undefined,
    ...more,
  });
  socket.on('error', ignore);
  onTestFinished(() => void socket.destroy());
  return socket;
}

/* One full connection that keeps the session it is given, and the same machine's next one that offers it. */
async function reusedOnReturn(stand: Stand, door: Door): Promise<boolean> {
  const first = tlsClientOf(stand, door.port, stand.worker);
  first.resume();
  const [session] = (await once(first, 'session')) as [Buffer];
  first.destroy();
  const secured = once(door.tls, 'secureConnection');
  const second = tlsClientOf(stand, door.port, stand.worker, { session });
  second.resume();
  const [socket] = (await secured) as [tls.TLSSocket];
  return socket.isSessionReused();
}

function requestOver(stream: Duplex, headers: http.OutgoingHttpHeaders): Promise<{ headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const out = http.request({ host: 'app.hornhoof.test', path: '/echo', headers, createConnection: () => stream }, res => {
      void textOf(res).then(text => resolve(JSON.parse(text) as { headers: Record<string, string> }), reject);
    });
    out.on('error', reject);
    out.end();
  });
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function connectFails(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', () => resolve(true));
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

describe('cutOnceAnswered', () => {
  /* A stream as far as the cut looks at it. left: whether its answer has left. */
  const streamOf = (left: () => boolean) => {
    const closed: number[] = [];
    const stream = { readableEnded: false, destroyed: false, closed: false, get state() { return { localClose: left() ? 1 : 0 }; }, close: (code: number) => void closed.push(code) };
    return { stream: stream as unknown as http2.ServerHttp2Stream, closed };
  };

  it('cuts the stream once its answer has left, and not before', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    let left = false;
    const s = streamOf(() => left);
    cutOnceAnswered(s.stream);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.closed).toEqual([]);
    left = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(s.closed).toEqual([http2.constants.NGHTTP2_NO_ERROR]);
  });

  it('cuts a stream whose answer never leaves after a while, so a peer that reads nothing holds no stream open', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    const s = streamOf(() => false);
    cutOnceAnswered(s.stream);
    await vi.advanceTimersByTimeAsync(4000);
    expect(s.closed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.closed).toEqual([http2.constants.NGHTTP2_NO_ERROR]);
    /* And it is looked at no more. */
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.closed).toHaveLength(1);
  });
});

describe('routeOf', () => {
  const db = { host: 'db', port: 5432 };
  const asked = (method: string, path?: string, authority?: string) => ({ ':method': method, ':path': path, ':authority': authority });
  const connect = (authority: string) => asked('CONNECT', undefined, authority);
  const refused = (status: number) => ({ to: 'refused', status });

  it.each([
    ['hello on the peer door', asked('GET', '/peer/hello'), 'peer', 'worker', db, { to: 'hello' }],
    ['hello on the app door', asked('GET', '/peer/hello'), 'app', 'worker', null, { to: 'hello' }],
    ['the app on the peer door', connect(APP_AUTHORITY), 'peer', 'worker', db, { to: 'app' }],
    ['the app on the app door', connect(APP_AUTHORITY), 'app', 'data', db, { to: 'app' }],
    ['the data role at the peer door', connect(DB_AUTHORITY), 'peer', 'data', db, { to: 'db', db }],
    ['a worker for db', connect(DB_AUTHORITY), 'peer', 'worker', db, refused(403)],
    ['db through the app door', connect(DB_AUTHORITY), 'app', 'data', db, refused(403)],
    ['db on a machine without one', connect(DB_AUTHORITY), 'peer', 'data', null, refused(403)],
    ['another host', connect('app:8081'), 'peer', 'data', db, refused(404)],
    ['another way of writing the host', connect('APP:8080'), 'peer', 'data', db, refused(404)],
    ['another method at hello', asked('POST', '/peer/hello'), 'peer', 'data', db, refused(404)],
    ['hello with a query', asked('GET', '/peer/hello?x=1'), 'peer', 'data', db, refused(404)],
    ['another path', asked('GET', '/'), 'peer', 'data', db, refused(404)],
    ['a request naming the app without CONNECT', asked('GET', '/', APP_AUTHORITY), 'peer', 'data', db, refused(404)],
    ['a bundle asked for', asked('GET', `/peer/backups/${INVOCATION}`), 'peer', 'worker', db, { to: 'bundle', id: INVOCATION, put: false }],
    ['a bundle sent, through the app door', asked('PUT', `/peer/backups/${INVOCATION}`), 'app', 'worker', null, { to: 'bundle', id: INVOCATION, put: true }],
    ['a bundle by no id', asked('GET', '/peer/backups/latest'), 'peer', 'worker', db, refused(404)],
    ['a bundle with more after its id', asked('GET', `/peer/backups/${INVOCATION}/head`), 'peer', 'worker', db, refused(404)],
    ['a bundle with a query', asked('GET', `/peer/backups/${INVOCATION}?x=1`), 'peer', 'worker', db, refused(404)],
    ['another method at a bundle', asked('DELETE', `/peer/backups/${INVOCATION}`), 'peer', 'data', db, refused(404)],
    ['an offer of a switch', asked('POST', '/peer/switch/offer'), 'peer', 'data', db, { to: 'switch', method: 'POST', path: '/peer/switch/offer' }],
    ['the state of a switch', asked('GET', `/peer/switch/state?switch=${INVOCATION}`), 'peer', 'data', db, { to: 'switch', method: 'GET', path: `/peer/switch/state?switch=${INVOCATION}` }],
    ['a switch from a worker', asked('POST', '/peer/switch/go'), 'peer', 'worker', db, refused(403)],
    ['a switch through the app door', asked('POST', '/peer/switch/go'), 'app', 'data', db, refused(403)],
    ['another method at a switch', asked('PUT', '/peer/switch/go'), 'peer', 'data', db, refused(404)],
    ['a word about an update', asked('POST', '/peer/updating'), 'peer', 'data', db, { to: 'switch', method: 'POST', path: '/peer/updating' }],
    ['a word about an update from a worker', asked('POST', '/peer/updating'), 'peer', 'worker', db, refused(403)],
    ['a word about an update through the app door', asked('POST', '/peer/updating'), 'app', 'data', db, refused(403)],
    ['a question at the path of an update', asked('GET', '/peer/updating'), 'peer', 'data', db, refused(404)],
    ["a keeper's beat", asked('POST', '/peer/beat'), 'peer', 'data', db, { to: 'switch', method: 'POST', path: '/peer/beat' }],
    ['a beat from a worker', asked('POST', '/peer/beat'), 'peer', 'worker', db, refused(403)],
    ['a beat through the app door', asked('POST', '/peer/beat'), 'app', 'data', db, refused(403)],
    ['an ask for the next term', asked('POST', '/peer/promise'), 'peer', 'data', db, { to: 'switch', method: 'POST', path: '/peer/promise' }],
    ["the CEO's word of which copy to go on from", asked('POST', '/peer/go-on'), 'peer', 'data', db, { to: 'switch', method: 'POST', path: '/peer/go-on' }],
    ["the CEO's word from a worker", asked('POST', '/peer/go-on'), 'peer', 'worker', db, refused(403)],
    ['the bundle of a database that led', asked('PUT', `/peer/led/${INVOCATION}`), 'peer', 'data', db, { to: 'led', id: INVOCATION }],
    ['such a bundle from a worker', asked('PUT', `/peer/led/${INVOCATION}`), 'peer', 'worker', db, refused(403)],
    ['such a bundle through the app door', asked('PUT', `/peer/led/${INVOCATION}`), 'app', 'data', db, refused(403)],
    ['such a bundle under no id', asked('PUT', '/peer/led/x'), 'peer', 'data', db, refused(404)],
    ['an ask for the next term from a worker', asked('POST', '/peer/promise'), 'peer', 'worker', db, refused(403)],
  ] as const)('%s', (_, headers, kind, role, here, route) => {
    expect(routeOf(headers, kind, role, here)).toEqual(route);
  });
});

describe('refusalOf', () => {
  const now = new Date('2026-06-15T12:00:00.000Z');
  const peer = (serial: string, until: Date): Peer => ({ machine: WORKER_ID, role: 'worker', serial, until, address: '127.0.0.1' });

  it('takes a certificate not on the list and still ahead of the clock', () => {
    expect(refusalOf(peer('ab', new Date(now.getTime() + 1)), new Set(['cd']), now)).toBeNull();
  });

  it('refuses a serial on the list', () => {
    expect(refusalOf(peer('ab', new Date(now.getTime() + 1)), new Set(['ab']), now)).toBe('CERT_REVOKED');
  });

  it('refuses a certificate at the moment it ends', () => {
    expect(refusalOf(peer('ab', now), new Set(), now)).toBe('CERT_HAS_EXPIRED');
  });
});

describe('OncePerMinute', () => {
  it('lets one line through per key and minute', () => {
    const gate = new OncePerMinute();
    expect(gate.allows('198.51.100.1', 0)).toBe(true);
    expect(gate.allows('198.51.100.1', MINUTE_MS - 1)).toBe(false);
    expect(gate.allows('198.51.100.2', MINUTE_MS - 1)).toBe(true);
    expect(gate.allows('198.51.100.1', MINUTE_MS)).toBe(true);
    expect(gate.allows('198.51.100.2', MINUTE_MS)).toBe(false);
  });
});

describe('peerHeaders', () => {
  const peer: Peer = { machine: WORKER_ID, role: 'worker', serial: 'ab', until: new Date(0), address: '203.0.113.9' };
  const asked = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;

  it('names the peer, and gives its address when it forwards for nobody', () => {
    expect(peerHeaders(asked({}), peer)).toEqual({ 'x-forwarded-for': '203.0.113.9', [VIA]: WORKER_ID });
  });

  it('keeps the first address the peer forwards for', () => {
    expect(peerHeaders(asked({ 'x-forwarded-for': '198.51.100.7, 192.0.2.1' }), peer)['x-forwarded-for']).toBe('198.51.100.7');
  });

  it("marks only the keeper's own requests", () => {
    const MARK = 'x-hornhoof-keeper';
    /* The peer's keeper asks as itself, with the header no front door lets a visitor write. */
    expect(peerHeaders(asked({ [VIA]: 'keeper' }), peer)).toMatchObject({ [VIA]: WORKER_ID, [MARK]: '1' });
    /* What came through the peer's front door has no such header, whatever else it says of itself. */
    expect(peerHeaders(asked({}), peer)).not.toHaveProperty(MARK);
    expect(peerHeaders(asked({ [MARK]: '1' }), peer)).not.toHaveProperty(MARK);
    expect(peerHeaders(asked({ [VIA]: WORKER_ID, [MARK]: '1' }), peer)).not.toHaveProperty(MARK);
  });

  it('passes an invocation only when it is a uuid', () => {
    expect(peerHeaders(asked({ 'x-hornhoof-invocation': INVOCATION }), peer)['x-hornhoof-invocation']).toBe(INVOCATION);
    expect(peerHeaders(asked({ 'x-hornhoof-invocation': 'not-a-uuid' }), peer)).not.toHaveProperty('x-hornhoof-invocation');
  });
});

describe('PeerServer', () => {
  it('refuses at the handshake every client without a valid certificate', async () => {
    const stand = await standUp();
    const other = await makeAuthority(OTHER_COMPANY);
    const clients = [
      undefined,
      await machineOf(other, WORKER_ID, 'worker'),
      await machineOf(stand.authority, WORKER_ID, 'worker', new Date(Date.now() - 31 * DAY_MS)),
      stand.listed,
    ];
    for (const kind of ['peer', 'app'] as const) {
      const door = await stand.open(kind);
      const seen = watched(door.tls);
      for (const [index, client] of clients.entries()) {
        const session = clientOf(stand, door.port, client);
        const answers = [HELLO, CONNECT_APP, CONNECT_DB].map(headers => statusOf(session.request(headers)));
        expect(await Promise.all(answers)).toEqual([null, null, null]);
        await until(() => seen.refused() === index + 1);
      }
      expect(seen.secure()).toBe(0);
      expect(seen.sessions()).toBe(0);
    }
    expect(stand.app.connections()).toBe(0);
    expect(stand.db.connections()).toBe(0);
  });

  it('says once a minute per address who was refused, and why', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const refuseOnce = async (): Promise<void> => {
      const refused = once(door.tls, 'tlsClientError');
      clientOf(stand, door.port, stand.listed);
      await refused;
    };
    await refuseOnce();
    expect(stand.lines).toEqual(['The peer link refused 127.0.0.1: CERT_REVOKED']);
    await refuseOnce();
    expect(stand.lines).toHaveLength(1);
    stand.state.now = new Date(stand.state.now.getTime() + MINUTE_MS);
    const refused = once(door.tls, 'tlsClientError');
    clientOf(stand, door.port);
    await refused;
    expect(stand.lines[1]).toBe('The peer link refused 127.0.0.1: ERR_SSL_PEER_DID_NOT_RETURN_A_CERTIFICATE');
  });

  it('does not resume a TLS session', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    expect(await reusedOnReturn(stand, door)).toBe(false);
    // setSecureContext takes its options anew, and a context made without this one would hand out tickets again.
    stand.server.refresh();
    expect(await reusedOnReturn(stand, door)).toBe(false);
  });

  it('answers hello with what the peer is seen as', async () => {
    const stand = await standUp();
    const door = await stand.open('app');
    const stream = clientOf(stand, door.port, stand.worker).request(HELLO);
    expect(await statusOf(stream)).toBe(200);
    expect(JSON.parse(await textOf(stream))).toEqual({ machine: WORKER_ID, role: 'worker', seen: '127.0.0.1' });
  });

  it('names the peer to the app by its certificate', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.worker);
    const stream = session.request(CONNECT_APP);
    expect(await statusOf(stream)).toBe(200);
    const asked = await requestOver(stream, {
      [VIA]: 'forged',
      'x-forwarded-for': '198.51.100.7',
      'x-hornhoof-invocation': INVOCATION,
    });
    expect(asked.headers[VIA]).toBe(WORKER_ID);
    expect(asked.headers['x-forwarded-for']).toBe('198.51.100.7');
    expect(asked.headers['x-hornhoof-invocation']).toBe(INVOCATION);

    const tunnel = session.request(CONNECT_APP);
    expect(await statusOf(tunnel)).toBe(200);
    const socket = new WebSocket('ws://app.hornhoof.test/socket', { createConnection: (() => tunnel) as never });
    socket.on('error', ignore);
    await once(socket, 'open');
    socket.send('ping');
    const [message] = (await once(socket, 'message')) as [Buffer];
    expect(String(message)).toBe(`${WORKER_ID}: ping`);
    socket.terminate();
  });

  it('takes CONNECT db only from a data certificate on the peer door', async () => {
    const stand = await standUp();
    const peerDoor = await stand.open('peer');
    const appDoor = await stand.open('app');

    const toDb = clientOf(stand, peerDoor.port, stand.data).request(CONNECT_DB);
    expect(await statusOf(toDb)).toBe(200);
    toDb.write('ping');
    const [echoed] = (await once(toDb, 'data')) as [Buffer];
    expect(String(echoed)).toBe('ping');
    expect(stand.db.connections()).toBe(1);

    expect(await statusOf(clientOf(stand, peerDoor.port, stand.worker).request(CONNECT_DB))).toBe(403);
    const onAppDoor = clientOf(stand, appDoor.port, stand.data);
    expect(await statusOf(onAppDoor.request(CONNECT_DB))).toBe(403);
    expect(stand.db.connections()).toBe(1);
    expect(await statusOf(onAppDoor.request(CONNECT_APP))).toBe(200);
  });

  /* A stand whose machine keeps backups: the keeper of them is made once the stand has its certificate. */
  async function standWithBackups() {
    const late: { peer?: PeerBackups } = {};
    const stand = await standUp({ backups: { get: (peer, id) => late.peer!.get(peer, id), put: (peer, id, body) => late.peer!.put(peer, id, body) } });
    const backups = await backupsOf(stand);
    late.peer = backups.keeper.peer();
    return { stand, backups };
  }

  /* The keeper of backups of the stand's own machine, with what its app says of the bundles, and bundles it made. */
  async function backupsOf(stand: Stand) {
    const identity = await age.generateX25519Identity();
    const own = { identity, recipient: await age.identityToRecipient(identity) };
    const held = stand.state.held!;
    const view: MakerView = { company: COMPANY, recipients: [], recovery: null, last: { id: randomUUID(), madeAt: new Date().toISOString(), recovery: null }, holders: {}, wanted: [], order: null, fork: null };
    const keeper = new BackupKeeper({
      dir: mkdtempSync(join(tmpdir(), 'hh-keeper-')), controlDir: mkdtempSync(join(tmpdir(), 'hh-control-')), key: stand.own.key, held: () => held, age: own,
      secrets: () => ({ HORNHOOF_SECRET: 's', NODE_KEY: 'n', RELAY_URL: 'r' }), ask: () => Promise.resolve({ status: 200, body: view }), leads: () => true, log: ignore,
    });
    const elsewhere = mkdtempSync(join(tmpdir(), 'hh-bundles-'));
    /* A bundle this machine sealed, left outside its store. */
    const sealed = async (bytes = 256 * 1024) => {
      const id = randomUUID();
      const out = join(elsewhere, `${id}.age`);
      const made = await sealBundle({
        dump: Readable.from([randomBytes(bytes)]), id, company: COMPANY, dumpedAt: new Date(), reason: 'timer', migrations: 106, secrets: { HORNHOOF_SECRET: 's', NODE_KEY: 'n', RELAY_URL: 'r' },
        recipients: [own.recipient], recovery: null, recoveryLink: null, key: stand.own.key, held, out,
      });
      /* As it travels: its two lines, then the sealed part. */
      const whole = Buffer.concat([Buffer.from(headLine(made.head)), readFileSync(out)]);
      return { id, out, ...made, travels: () => whole };
    };
    return { keeper, view, sealed };
  }
  const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

  it('serves a bundle only to its holders', async () => {
    const { stand, backups } = await standWithBackups();
    const x = await backups.sealed();
    await backups.keeper.store().seal(x.id, part => {
      copyFileSync(x.out, part);
      return Promise.resolve({ head: x.head, manifest: x.manifest });
    });
    backups.view.holders = { [x.id]: [WORKER_ID] };
    await backups.keeper.round();
    for (const kind of ['peer', 'app'] as const) {
      const door = await stand.open(kind);
      const holder = clientOf(stand, door.port, stand.worker);
      const got = holder.request({ ':path': `${PEER_PATHS.backups}${x.id}` });
      const headers = await new Promise<http2.IncomingHttpHeaders>(resolve => got.once('response', resolve));
      const bytes = await buffer(got);
      expect([headers[':status'], Number(headers['content-length']), sha256(bytes)], kind).toEqual([200, bytes.length, sha256(await buffer(backups.keeper.store().open(x.id)!.stream()))]);
      expect(bytes.length, kind).toBe(backups.keeper.store().open(x.id)!.length);
      /* Another machine of the company is none of its holders; a bundle this machine does not hold is nobody's. */
      const other = clientOf(stand, door.port, stand.data);
      expect(await statusOf(other.request({ ':path': `${PEER_PATHS.backups}${x.id}` })), kind).toBe(403);
      expect(await statusOf(holder.request({ ':path': `${PEER_PATHS.backups}${randomUUID()}` })), kind).toBe(404);
      /* Nobody sends one that was not asked for. */
      const sent = holder.request({ ':method': 'PUT', ':path': `${PEER_PATHS.backups}${x.id}` });
      sent.end(x.travels());
      expect(await statusOf(sent), kind).toBe(403);
    }
    /* A machine that keeps no backups serves none. */
    const plain = await standUp();
    const without = await plain.open('peer');
    const asking = clientOf(plain, without.port, plain.worker);
    expect(await statusOf(asking.request({ ':path': `${PEER_PATHS.backups}${x.id}` }))).toBe(404);
    const sending = asking.request({ ':method': 'PUT', ':path': `${PEER_PATHS.backups}${x.id}` });
    sending.end('x');
    expect(await statusOf(sending)).toBe(404);
  });

  it('takes back a bundle it asked a holder for, and cuts one that is not what its head says', async () => {
    const { stand, backups } = await standWithBackups();
    const [wanted, long] = [await backups.sealed(), await backups.sealed()];
    backups.view.wanted = [{ id: wanted.id, from: WORKER_ID }, { id: long.id, from: WORKER_ID }];
    await backups.keeper.round();
    const door = await stand.open('peer');
    const holder = clientOf(stand, door.port, stand.worker);
    const put = (id: string) => holder.request({ ':method': 'PUT', ':path': `${PEER_PATHS.backups}${id}` });
    /* From another machine than the one asked: refused. */
    const stranger = clientOf(stand, door.port, stand.data).request({ ':method': 'PUT', ':path': `${PEER_PATHS.backups}${wanted.id}` });
    stranger.end(wanted.travels());
    expect(await statusOf(stranger)).toBe(403);
    const sent = put(wanted.id);
    sent.end(wanted.travels());
    expect(await statusOf(sent)).toBe(201);
    expect(backups.keeper.held()).toEqual([wanted.id]);
    /* Held already: taken as done, without reading it again. */
    const again = put(wanted.id);
    again.end(Buffer.alloc(16));
    expect(await statusOf(again)).toBe(201);

    /* Longer than its head says: refused once it passes the signed size, long before its end. */
    const MIB = 1024 * 1024;
    const tooLong = put(long.id);
    const answered = statusOf(tooLong);
    const gone = closeOf(tooLong);
    tooLong.resume();
    let accepted = 0;
    tooLong.write(long.travels());
    const chunk = Buffer.alloc(64 * 1024);
    for (let sentBytes = 0; sentBytes < 32 * MIB && !tooLong.destroyed && !tooLong.closed; sentBytes += chunk.length) {
      if (!tooLong.write(chunk, err => (accepted += err ? 0 : chunk.length))) await Promise.race([new Promise(resolve => tooLong.once('drain', resolve)), gone]);
    }
    expect(await answered).toBe(400);
    await gone;
    expect(accepted).toBeLessThan(3 * MIB);
    expect(backups.keeper.held()).toEqual([wanted.id]);
    /* Under another bundle's name: refused as well. */
    const misnamed = put(long.id);
    misnamed.end(wanted.travels());
    expect(await statusOf(misnamed)).toBe(400);
  });

  /* A stand whose keeper takes uploads from the worker's machine, into a control folder of the test's. */
  async function standWithUploads(max = 1024 * 1024) {
    const controlDir = mkdtempSync(join(tmpdir(), 'hh-control-'));
    const lines: string[] = [];
    const networkId = `99bb2233aabbccdd${'2'.repeat(48)}`;
    const allowed = [{ machine: WORKER_ID, networkId, max, unpackMax: 4 * max }];
    const taker = new UploadTaker({ controlDir, allowed: () => allowed, log: line => lines.push(line), now: () => new Date('2026-11-11T12:00:05Z') });
    const stand = await standUp({ uploads: taker.peer() });
    const door = await stand.open('peer');
    const put = (id: string, length: number | null, machine = stand.worker) =>
      clientOf(stand, door.port, machine).request({ ':method': 'PUT', ':path': `${PEER_PATHS.upload}${id}`, ...(length === null ? {} : { 'content-length': length }) });
    const files = () => (existsSync(join(controlDir, UPLOADS_DIR)) ? readdirSync(join(controlDir, UPLOADS_DIR)).sort() : []);
    return { stand, taker, controlDir, networkId, allowed, put, files, lines };
  }

  it('takes an upload from a machine that must give one', async () => {
    const u = await standWithUploads();
    const id = randomUUID();
    const bytes = randomBytes(300 * 1024);
    const sent = u.put(id, bytes.length);
    sent.end(bytes);
    expect(await statusOf(sent)).toBe(201);
    const name = `${u.networkId}-${id}.tar.gz`;
    expect(u.files()).toEqual([name]);
    const file = join(u.controlDir, UPLOADS_DIR, name);
    expect(readFileSync(file).equals(bytes)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(u.controlDir, UPLOADS_DIR)).mode & 0o777).toBe(0o700);
    /* The updater is asked to load it, into a database named after the machine and the moment. */
    const load = JSON.parse(readFileSync(join(u.controlDir, LOAD_FILE), 'utf8')) as Record<string, unknown>;
    expect(load).toEqual({ id, machine: WORKER_ID, file, database: 'hornhoof_upload_99bb2233aabbccdd_20261111t120005', unpackMax: 4 * 1024 * 1024 });
    expect(statSync(join(u.controlDir, LOAD_FILE)).mode & 0o777).toBe(0o600);
  });

  it('refuses an upload from anyone else, and takes none where the keeper takes none', async () => {
    const u = await standWithUploads();
    const stranger = u.put(randomUUID(), 1024, u.stand.data);
    stranger.end(Buffer.alloc(1024));
    expect(await statusOf(stranger)).toBe(403);
    /* One that is still sending is told so too: the answer leaves before its stream is cut. */
    const sending = u.put(randomUUID(), 2048, u.stand.data);
    sending.write(Buffer.alloc(1024));
    expect(await statusOf(sending)).toBe(403);
    expect(u.files()).toEqual([]);
    expect(existsSync(join(u.controlDir, LOAD_FILE))).toBe(false);
    /* The machine owes nothing any more. */
    u.allowed.length = 0;
    const late = u.put(randomUUID(), 1024);
    late.end(Buffer.alloc(1024));
    expect(await statusOf(late)).toBe(403);
    /* A keeper with nothing that takes uploads knows no such path. */
    const plain = await standUp();
    const door = await plain.open('peer');
    const none = clientOf(plain, door.port, plain.worker).request({ ':method': 'PUT', ':path': `${PEER_PATHS.upload}${randomUUID()}` });
    none.end(Buffer.alloc(16));
    expect(await statusOf(none)).toBe(404);
  });

  it('keeps no part of an upload that is too large or was cut', async () => {
    const u = await standWithUploads(64 * 1024);
    /* Larger than it may be, or of no length it says first: refused before a byte is kept. */
    for (const [length, status] of [[512 * 1024, 413], [null, 400]] as const) {
      const refused = u.put(randomUUID(), length);
      const answered = statusOf(refused);
      refused.on('error', ignore);
      refused.resume();
      refused.end(randomBytes(512 * 1024));
      expect(await answered).toBe(status);
      expect(u.files()).toEqual([]);
      expect(existsSync(join(u.controlDir, LOAD_FILE))).toBe(false);
    }
    /* Cut in the middle: nothing of it stays, no load is asked for, and the next one is taken. */
    const cut = u.put(randomUUID(), 48 * 1024);
    cut.on('error', ignore);
    cut.write(randomBytes(16 * 1024));
    await until(() => u.files().some(name => name.endsWith('.part')));
    cut.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => u.files().length === 0);
    expect(existsSync(join(u.controlDir, LOAD_FILE))).toBe(false);
    const id = randomUUID();
    const next = u.put(id, 1024);
    next.end(randomBytes(1024));
    expect(await statusOf(next)).toBe(201);
    /* A part an earlier keeper left is no upload, and goes when the keeper starts; an upload whose load is asked stays. */
    writeFileSync(join(u.controlDir, UPLOADS_DIR, 'left-over.tar.gz.part'), 'half');
    u.taker.start();
    expect(u.files()).toEqual([`${u.networkId}-${id}.tar.gz`]);
    /* One a keeper took and asked no load of is none either. */
    rmSync(join(u.controlDir, LOAD_FILE));
    u.taker.start();
    expect(u.files()).toEqual([]);
  });

  it('takes one upload at a time', async () => {
    const u = await standWithUploads();
    const first = randomUUID();
    const one = u.put(first, 2048);
    one.on('error', ignore);
    one.write(randomBytes(1024));
    await until(() => u.files().some(name => name.endsWith('.part')));
    /* A second one while the first still comes. */
    const two = u.put(randomUUID(), 1024);
    two.end(randomBytes(1024));
    expect(await statusOf(two)).toBe(409);
    one.end(randomBytes(1024));
    expect(await statusOf(one)).toBe(201);
    /* And while the updater still loads the first, also for the first itself. */
    for (const id of [randomUUID(), first]) {
      const three = u.put(id, 1024);
      three.end(randomBytes(1024));
      expect(await statusOf(three)).toBe(409);
    }
    /* The load failed: the same upload is taken again. */
    const place = join(u.controlDir, UPLOADS_DIR, `${u.networkId}-${first}`);
    rmSync(join(u.controlDir, LOAD_FILE));
    rmSync(`${place}.tar.gz`);
    writeFileSync(`${place}.failed`, 'The upload could not be loaded.\n');
    const four = u.put(first, 1024);
    four.end(randomBytes(1024));
    expect(await statusOf(four)).toBe(201);
    expect(u.files()).toEqual([`${u.networkId}-${first}.tar.gz`]);
    /* The load went through: offered again, it is answered as taken, and nothing is taken or loaded twice. */
    rmSync(join(u.controlDir, LOAD_FILE));
    rmSync(`${place}.tar.gz`);
    writeFileSync(`${place}.done`, '');
    const five = u.put(first, 1024);
    five.on('error', ignore);
    five.end(randomBytes(1024));
    expect(await statusOf(five)).toBe(201);
    expect([u.files(), existsSync(join(u.controlDir, LOAD_FILE))]).toEqual([[`${u.networkId}-${first}.done`], false]);
    /* What was said of a machine that owes nothing any more goes when the next one comes. */
    u.allowed[0] = { ...u.allowed[0]!, machine: DATA_ID, networkId: 'ab'.repeat(32) };
    const six = u.put(randomUUID(), 1024, u.stand.data);
    six.end(randomBytes(1024));
    expect(await statusOf(six)).toBe(201);
    expect(u.files().filter(name => name.endsWith('.done'))).toEqual([]);
  });

  it('passes the paths of a switch to what handles them, with the body as JSON', async () => {
    const asked: unknown[] = [];
    const done: string[] = [];
    const stand = await standUp({
      switches: {
        handle: async (peer, method, path, body) => {
          asked.push([peer.machine, method, path, body]);
          return path.endsWith('/go') ? { status: 200, body: { ok: true }, after: () => void done.push('after') } : { status: 409, body: { ok: false, why: 'not_ready' } };
        },
      },
    });
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.data);
    const post = async (path: string, body: string) => {
      const stream = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json' });
      stream.end(body);
      const status = await statusOf(stream);
      return [status, status === null ? '' : await textOf(stream)];
    };
    expect(await post('/peer/switch/offer', JSON.stringify({ switch: INVOCATION }))).toEqual([409, JSON.stringify({ ok: false, why: 'not_ready' })]);
    expect(done).toEqual([]);
    /* What comes after the answer is done once the answer has gone out. */
    expect(await post('/peer/switch/go', JSON.stringify({ switch: INVOCATION, w: '0/1', copies: [] }))).toEqual([200, JSON.stringify({ ok: true })]);
    await until(() => done.length === 1);
    const state = session.request({ ':method': 'GET', ':path': `/peer/switch/state?switch=${INVOCATION}` });
    state.end();
    expect(await statusOf(state)).toBe(409);
    expect(asked).toEqual([
      [DATA_ID, 'POST', '/peer/switch/offer', { switch: INVOCATION }],
      [DATA_ID, 'POST', '/peer/switch/go', { switch: INVOCATION, w: '0/1', copies: [] }],
      [DATA_ID, 'GET', `/peer/switch/state?switch=${INVOCATION}`, undefined],
    ]);
    /* A body that is no JSON, or too long, reaches nothing. */
    expect((await post('/peer/switch/offer', '{'))[0]).toBe(400);
    expect((await post('/peer/switch/offer', JSON.stringify({ pad: 'x'.repeat(70_000) })))[0]).toBe(400);
    expect(asked).toHaveLength(3);
    /* A worker is refused, and a keeper that takes part in no switch knows no such path. */
    const worker = clientOf(stand, door.port, stand.worker).request({ ':method': 'POST', ':path': '/peer/switch/offer' });
    worker.end('{}');
    expect(await statusOf(worker)).toBe(403);
    const plain = await standUp();
    const other = await plain.open('peer');
    const none = clientOf(plain, other.port, plain.data).request({ ':method': 'POST', ':path': '/peer/switch/offer' });
    none.end('{}');
    expect(await statusOf(none)).toBe(404);
  });

  it('does what a switch wants done after its answer also when the stream that carried it is gone first', async () => {
    const asked = deferred();
    const answered = deferred<{ status: number; body: object; after?: () => void }>();
    const done: string[] = [];
    const stand = await standUp({
      switches: {
        handle: async () => {
          asked.resolve();
          return answered.promise;
        },
      },
    });
    const door = await stand.open('peer');
    const served: http2.ServerHttp2Stream[] = [];
    door.tls.on('stream', stream => void served.push(stream));
    const stream = clientOf(stand, door.port, stand.data).request({ ':method': 'POST', ':path': '/peer/switch/abort', 'content-type': 'application/json' });
    stream.on('error', ignore);
    stream.end(JSON.stringify({ switch: INVOCATION }));
    await asked.promise;
    /* The peer leaves while what it asked is being done: the answer has nowhere to go, and what was done stands. */
    stream.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => served[0]?.closed === true);
    answered.resolve({ status: 200, body: { ok: true }, after: () => void done.push('after') });
    /* What handles the answer goes on in promises alone, which all settle before the next turn of the event loop. */
    await new Promise(resolve => setImmediate(resolve));
    expect(done).toEqual(['after']);
  });

  it('answers anything else with 404, and a door that cannot connect with 502', async () => {
    const stand = await standUp({ door: { connect: () => Promise.reject(new Error('No door.')) } });
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.worker);
    expect(await statusOf(session.request({ ':path': '/other' }))).toBe(404);
    expect(await statusOf(session.request(CONNECT_APP))).toBe(502);
  });

  it("counts the bytes to each machine's db", async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    expect(stand.server.dbBytes(DATA_ID)).toBe(0);
    const toDb = clientOf(stand, door.port, stand.data).request(CONNECT_DB);
    expect(await statusOf(toDb)).toBe(200);
    const sent = randomBytes(2 * 1024 * 1024);
    let back = 0;
    toDb.on('data', (chunk: Buffer) => (back += chunk.length));
    toDb.write(sent);
    await until(() => back === sent.length);
    expect(stand.server.dbBytes(DATA_ID)).toBeGreaterThanOrEqual(sent.length);
    expect(stand.server.dbBytes(WORKER_ID)).toBe(0);
    /* What its other streams carry counts with it. */
    const second = clientOf(stand, door.port, stand.data).request(CONNECT_DB);
    expect(await statusOf(second)).toBe(200);
    second.write('more');
    await once(second, 'data');
    expect(stand.server.dbBytes(DATA_ID)).toBeGreaterThanOrEqual(sent.length + 4);
  });

  it('counts what it sends each machine', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    expect(stand.server.sentBytes().size).toBe(0);
    /* The database's stream to one machine, as a copy's is, and a hello to another. */
    const toDb = clientOf(stand, door.port, stand.data).request(CONNECT_DB);
    expect(await statusOf(toDb)).toBe(200);
    const sent = randomBytes(5 * 1024 * 1024);
    let back = 0;
    toDb.on('data', (chunk: Buffer) => (back += chunk.length));
    toDb.write(sent);
    await until(() => back === sent.length);
    const hello = clientOf(stand, door.port, stand.worker).request(HELLO);
    hello.end();
    let said = 0;
    hello.on('data', (chunk: Buffer) => (said += chunk.length));
    await once(hello, 'end');
    const counts = stand.server.sentBytes();
    expect(counts.get(DATA_ID)).toBeGreaterThanOrEqual(sent.length);
    expect(counts.get(WORKER_ID)).toBe(said);
    expect(said).toBeGreaterThan(0);
  });

  it('answers 502 when the database does not take the connection', async () => {
    const stand = await standUp({ db: { host: '127.0.0.1', port: await freePort() } });
    const door = await stand.open('peer');
    expect(await statusOf(clientOf(stand, door.port, stand.data).request(CONNECT_DB))).toBe(502);
  });

  it('destroys the far side when a stream closes, and ends the stream when the far side ends', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.data);

    const cancelled = session.request(CONNECT_DB);
    expect(await statusOf(cancelled)).toBe(200);
    await until(() => stand.db.connections() === 1);
    const farGone = closeOf(stand.db.sockets[0]!);
    cancelled.close(http2.constants.NGHTTP2_CANCEL);
    await farGone;

    const answered = session.request(CONNECT_DB);
    expect(await statusOf(answered)).toBe(200);
    answered.write('last words');
    await until(() => stand.db.sockets[1]?.bytesWritten === 'last words'.length);
    stand.db.sockets[1]!.end();
    expect(await textOf(answered)).toBe('last words');
  });

  it('delivers what the far side said last, however slowly the peer reads', async () => {
    const last = Buffer.alloc(4096, 'x');
    const talker = await listening(
      net.createServer(socket => {
        socket.on('error', ignore);
        socket.end(last);
      }),
    );
    const stand = await standUp({ db: talker.target });
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.data, { settings: { initialWindowSize: 1024 } });
    const stream = session.request(CONNECT_DB);
    expect(await statusOf(stream)).toBe(200);
    // Only the first kilobyte may travel until the peer reads, and the far side says its last and leaves meanwhile.
    await until(() => talker.connections() === 1);
    await until(() => talker.sockets[0]!.writableFinished);
    expect((await textOf(stream)).length).toBe(last.length);
  });

  it('destroys the far side when a stream closes, even a far side that takes no notice of the end', async () => {
    const far = new PassThrough();
    const stand = await standUp({ door: { connect: () => Promise.resolve(far) } });
    const door = await stand.open('peer');
    const stream = clientOf(stand, door.port, stand.worker).request(CONNECT_APP);
    expect(await statusOf(stream)).toBe(200);
    stream.close(http2.constants.NGHTTP2_CANCEL);
    await until(() => far.destroyed);
  });

  it('tells a broken far side from one that has finished', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const stream = clientOf(stand, door.port, stand.data).request(CONNECT_DB);
    const gone = closeOf(stream);
    expect(await statusOf(stream)).toBe(200);
    await until(() => stand.db.connections() === 1);
    stand.db.sockets[0]!.resetAndDestroy();
    await gone;
    expect(stream.rstCode).toBe(http2.constants.NGHTTP2_CONNECT_ERROR);
  });

  it('lets a stream close when its peer sent more after the far side had left', async () => {
    const leaving = await listening(net.createServer(socket => void socket.end()));
    const stand = await standUp({ db: leaving.target });
    const door = await stand.open('peer');
    const heard = once(door.tls, 'stream');
    const stream = clientOf(stand, door.port, stand.data).request(CONNECT_DB);
    const [served] = (await heard) as [Duplex];
    const gone = closeOf(served);
    expect(await statusOf(stream)).toBe(200);
    await until(() => leaving.connections() === 1);
    await closeOf(leaving.sockets[0]!);
    stream.resume();
    stream.end('late bytes');
    await gone;
  });

  it('drops a connection that arrives for a stream already gone', async () => {
    const arriving = deferred<Duplex>();
    const stand = await standUp({ door: { connect: () => arriving.promise } });
    const door = await stand.open('peer');
    const heard = once(door.tls, 'stream');
    const stream = clientOf(stand, door.port, stand.worker).request(CONNECT_APP);
    stream.on('error', ignore);
    const [served] = (await heard) as [Duplex];
    const closed = closeOf(served);
    stream.close(http2.constants.NGHTTP2_CANCEL);
    await closed;
    const far = new PassThrough();
    arriving.resolve(far);
    await until(() => far.destroyed);
  });

  it('closes a session once its certificate is revoked', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.worker);
    const tunnel = session.request(CONNECT_APP);
    expect(await statusOf(tunnel)).toBe(200);
    const closed = closeOf(session);
    const toDb = clientOf(stand, door.port, stand.data).request(CONNECT_DB);
    expect(await statusOf(toDb)).toBe(200);
    await until(() => stand.db.connections() === 1);
    const farGone = closeOf(stand.db.sockets[0]!);

    const revoked = [stand.listed.serial, stand.worker.serial, stand.data.serial];
    stand.state.revoked = new Set(revoked);
    stand.state.crl = await makeCrl(stand.authority, revoked);
    stand.server.refresh();
    await closed;
    await farGone;

    const seen = watched(door.tls);
    expect(await statusOf(clientOf(stand, door.port, stand.worker).request(HELLO))).toBeNull();
    await until(() => seen.refused() === 1);
    expect(seen.secure()).toBe(0);
  });

  it('closes a session once its certificate expires', async () => {
    const stand = await standUp({ sweepMs: 50 });
    const door = await stand.open('peer');
    // The idle session asks nothing more, so only the sweep can close it.
    const idle = clientOf(stand, door.port, stand.worker);
    expect(await statusOf(idle.request(CONNECT_APP))).toBe(200);
    const asking = clientOf(stand, door.port, stand.worker);
    expect(await statusOf(asking.request(HELLO))).toBe(200);
    const closed = closeOf(idle);

    stand.state.now = new Date(stand.worker.until.getTime() + 1);
    const late = statusOf(asking.request(HELLO));
    await closed;
    expect(await late).toBeNull();
  });

  it('refuses a certificate the handshake took but the list has since named, or that names no machine', async () => {
    const stand = await standUp({ sweepMs: 3_600_000 });
    const door = await stand.open('peer');
    const seen = watched(door.tls);
    stand.state.revoked = new Set([stand.worker.serial]);
    for (const client of [stand.worker, await namelessUnder(stand.authority)]) {
      expect(await statusOf(clientOf(stand, door.port, client).request(CONNECT_APP))).toBeNull();
    }
    expect(seen.secure()).toBe(2);
    expect(stand.app.connections()).toBe(0);
    expect(stand.lines).toEqual(['The peer link refused 127.0.0.1: CERT_REVOKED']);
    stand.state.now = new Date(stand.state.now.getTime() + MINUTE_MS);
    expect(await statusOf(clientOf(stand, door.port, await namelessUnder(stand.authority)).request(HELLO))).toBeNull();
    expect(stand.lines[1]).toBe('The peer link refused 127.0.0.1: NAMES_NO_MACHINE');
  });

  it('checks a session again on each new stream, without waiting for a sweep', async () => {
    const stand = await standUp({ sweepMs: 3_600_000 });
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.worker);
    expect(await statusOf(session.request(HELLO))).toBe(200);
    stand.state.revoked = new Set([stand.worker.serial]);
    const closed = closeOf(session);
    expect(await statusOf(session.request(CONNECT_APP))).toBeNull();
    await closed;
    expect(stand.app.connections()).toBe(0);
  });

  it('gives nothing to a client that does not speak HTTP/2, whatever its certificate', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const socket = tlsClientOf(stand, door.port, stand.worker, { ALPNProtocols: [] });
    const closed = closeOf(socket);
    const text = textOf(socket).catch(() => '');
    await closed;
    expect(await text).toBe('');
  });

  it('takes no TLS below 1.3', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const seen = watched(door.tls);
    const socket = tlsClientOf(stand, door.port, stand.worker, { maxVersion: 'TLSv1.2' });
    await closeOf(socket);
    expect(seen.refused()).toBe(1);
    expect(seen.secure()).toBe(0);
  });

  it('takes a new certificate of its own', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const renewed = await issueCertificate(stand.authority, { machineId: OWN_ID, role: 'data', signKey: stand.own.key.publicPem });
    stand.state.held = heldOf({ ...stand.own, certPem: renewed.certPem }, stand.authority);
    stand.server.refresh();
    const socket = tlsClientOf(stand, door.port, stand.worker);
    await once(socket, 'secureConnect');
    expect(socket.getPeerCertificate().serialNumber.toLowerCase()).toBe(renewed.serial);
  });

  it('keeps what it serves when its new certificate or list cannot be read, and says so once a minute', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const goodList = stand.state.crl;
    stand.state.crl = 'not a list';
    stand.server.refresh();
    stand.server.refresh();
    expect(stand.lines).toHaveLength(1);
    expect(stand.lines[0]).toMatch(/^The peer link could not read its certificate or its list: ERR_/);
    expect(await statusOf(clientOf(stand, door.port, stand.worker).request(HELLO))).toBe(200);
    expect(await statusOf(clientOf(stand, door.port, stand.listed).request(HELLO))).toBeNull();
    stand.lines.length = 0;
    stand.state.crl = goodList;
    stand.server.refresh();
    expect(stand.lines).toEqual([]);
  });

  it('answers nothing before it holds a certificate and a CRL', async () => {
    const stand = await standUp();
    const held = stand.state.held;
    const crl = stand.state.crl;
    for (const missing of [{ held: null, crl }, { held, crl: null }, { held, crl: 'not a list' }]) {
      Object.assign(stand.state, missing);
      const port = await freePort();
      let answered = false;
      const listen = stand.server.listen(port, 'peer', '127.0.0.1').then(given => {
        answered = true;
        return given;
      });
      stand.server.refresh();
      expect(await connectFails(port)).toBe(true);
      expect(answered).toBe(false);
      Object.assign(stand.state, { held, crl });
      stand.server.refresh();
      expect(await listen).toBe(port);
      expect(await connectFails(port)).toBe(false);
    }
  });

  it('says so when it cannot take its port', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    await expect(stand.server.listen(door.port, 'app', '127.0.0.1')).rejects.toThrow('EADDRINUSE');
    expect(await statusOf(clientOf(stand, door.port, stand.worker).request(HELLO))).toBe(200);
  });

  it('closes its listeners and every session, and gives up a listen still waiting', async () => {
    const stand = await standUp();
    const door = await stand.open('peer');
    const session = clientOf(stand, door.port, stand.worker);
    expect(await statusOf(session.request(HELLO))).toBe(200);
    const closed = closeOf(session);
    const idle = net.connect({ host: '127.0.0.1', port: door.port });
    idle.on('error', ignore);
    await once(idle, 'connect');
    stand.state.held = null;
    const gaveUp = expect(stand.server.listen(0, 'app', '127.0.0.1')).rejects.toThrow('The peer link closed before it could listen.');

    await stand.server.close();

    await closed;
    await gaveUp;
    expect(await connectFails(door.port)).toBe(true);
  });
});

describe('PeerDoor', () => {
  it('destroys a connection nobody registered, and the app sees nothing', async () => {
    const app = await echoApp();
    const door = new PeerDoor({ app: app.target });
    await door.start();
    onTestFinished(() => door.stop());
    const peer: Peer = { machine: WORKER_ID, role: 'worker', serial: 'ab', until: new Date(0), address: '127.0.0.1' };
    const registered = (await door.connect(peer)) as net.Socket;
    const stranger = net.connect({ host: '127.0.0.1', port: registered.remotePort! });
    stranger.on('error', ignore);
    const text = textOf(stranger).catch(() => '');
    stranger.write('GET /echo HTTP/1.1\r\nHost: app.hornhoof.test\r\n\r\n');
    expect(await text).toBe('');
    expect(app.connections()).toBe(0);
  });
});
