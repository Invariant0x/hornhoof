import { constants } from 'node:crypto';
import http2 from 'node:http2';
import type { Http2SecureServer, Http2Session, IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from 'node:http2';
import type net from 'node:net';
import type { AddressInfo } from 'node:net';
import { PassThrough, type Duplex, type Readable } from 'node:stream';
import tls from 'node:tls';
import type { PeerBackups } from '../modules/keeper/backups.js';
import type { PeerUploads } from '../modules/keeper/uploads.js';
import type { HeldCertificate } from '../modules/keeper/certificate.js';
import type { MachineKey } from '../modules/keeper/machine-keys.js';
import { certFacts } from '../modules/network/authority.js';
import type { MachineRole } from '../db/schema.js';
import { openTcp } from './peer-door.js';
import { UUID, type Target } from './proxy.js';

export const PEER_PATHS = { hello: '/peer/hello', backups: '/peer/backups/', files: '/peer/files/', upload: '/peer/upload/', switch: '/peer/switch/', updating: '/peer/updating', beat: '/peer/beat', promise: '/peer/promise', goOn: '/peer/go-on', led: '/peer/led/' } as const;
export const APP_AUTHORITY = 'app:8080';
export const DB_AUTHORITY = 'db:5432';

export type Peer = { machine: string; role: MachineRole; serial: string; until: Date; address: string };
/* A sealed file of the store by the sha256 of its plain bytes. */
export type PeerFiles = {
  get(peer: Peer, sha256: string): Promise<{ status: 200; length: number; stream(): Readable } | { status: 403 | 404 }>;
  put(peer: Peer, sha256: string, body: Readable): Promise<number>;
};
const FILE_NAME = /^[0-9a-f]{64}$/;
export type PeerServerOptions = {
  held: () => HeldCertificate | null;
  key: MachineKey;
  /* The authority's CRL, PEM. */
  crl: () => string | null;
  /* The serials revoked now, the CRL's and any since. */
  revoked: () => ReadonlySet<string>;
  /* A connection to the peer door for this peer. */
  door: { connect(peer: Peer): Promise<Duplex> };
  /* This machine's db; null: no CONNECT db. */
  db: Target | null;
  /* Answered with seen: peer.address added. */
  hello: (peer: Peer) => Record<string, unknown>;
  /* The bundles this machine gives to the machines that hold them, and takes back from one; without it, neither. */
  backups?: PeerBackups;
  /* The sealed files of the company's store, which a machine that holds them takes from here, and a file this machine
     asked for, which comes back; without it, neither. */
  files?: PeerFiles;
  /* What takes the upload of a machine that stopped holding the company's data; without it, none is taken. */
  uploads?: PeerUploads;
  /* What answers the keeper of another data machine: about a planned switch of the server, about an update of the
     machine that leads, and to its beat; without it, nothing does. */
  switches?: PeerSwitches;
  /* What takes the bundle a machine that led sealed of its own database, and says how its record went; without it,
     none is taken. */
  leds?: { put(peer: Peer, id: string, body: Readable): Promise<number> };
  log: (line: string) => void;
  now?: () => Date;
  sweepMs?: number;
};
/* The paths of a planned switch, as one data machine's keeper asks them of another's: the method, the path with its
   query, and the body as JSON, none for a GET. after: done once the answer has gone out. */
export type PeerSwitches = { handle(peer: Peer, method: 'GET' | 'POST', path: string, body: unknown): Promise<{ status: number; body: object; after?: () => void }> };
type Kind = 'peer' | 'app';
type Route =
  | { to: 'hello' } | { to: 'app' } | { to: 'db'; db: Target } | { to: 'bundle'; id: string; put: boolean } | { to: 'file'; sha256: string; put: boolean } | { to: 'upload'; id: string; length: number | null }
  | { to: 'switch'; method: 'GET' | 'POST'; path: string } | { to: 'led'; id: string } | { to: 'refused'; status: 403 | 404 };
type Waiting = { port: number; kind: Kind; host: string; resolve: (port: number) => void; reject: (err: Error) => void };

const SWEEP_MS = 5000;
const SWITCH_BODY_BYTES = 64 * 1024;
/* How often an answer the socket has not taken yet is looked at again, and how many times: about five seconds. */
const ANSWER_LEAVES_MS = 10;
const ANSWER_LEAVES_LOOKS = 500;
const MINUTE_MS = 60_000;
const ANY_ADDRESS = '0.0.0.0';
const CERT_REVOKED = 'CERT_REVOKED';
const CERT_HAS_EXPIRED = 'CERT_HAS_EXPIRED';
const NAMES_NO_MACHINE = 'NAMES_NO_MACHINE';
const CONTEXT_FAILURE = 'context';
const CLOSED = 'The peer link closed before it could listen.';

const ignore = (): void => {};

function routeOfConnect(authority: unknown, kind: Kind, role: MachineRole, db: Target | null): Route {
  if (authority === APP_AUTHORITY) return { to: 'app' };
  if (authority !== DB_AUTHORITY) return { to: 'refused', status: 404 };
  return kind === 'peer' && role === 'data' && db ? { to: 'db', db } : { to: 'refused', status: 403 };
}

export function routeOf(headers: IncomingHttpHeaders, kind: Kind, role: MachineRole, db: Target | null): Route {
  const method = headers[':method'];
  const path = String(headers[':path']);
  if (method === 'CONNECT') return routeOfConnect(headers[':authority'], kind, role, db);
  if ((method === 'GET' || method === 'PUT') && path.startsWith(PEER_PATHS.backups) && UUID.test(path.slice(PEER_PATHS.backups.length))) {
    return { to: 'bundle', id: path.slice(PEER_PATHS.backups.length), put: method === 'PUT' };
  }
  if ((method === 'GET' || method === 'PUT') && path.startsWith(PEER_PATHS.files) && FILE_NAME.test(path.slice(PEER_PATHS.files.length))) {
    return { to: 'file', sha256: path.slice(PEER_PATHS.files.length), put: method === 'PUT' };
  }
  if (method === 'PUT' && path.startsWith(PEER_PATHS.upload) && UUID.test(path.slice(PEER_PATHS.upload.length))) {
    const length = /^\d{1,15}$/.test(String(headers['content-length'])) ? Number(headers['content-length']) : null;
    return { to: 'upload', id: path.slice(PEER_PATHS.upload.length), length };
  }
  /* What a machine that led gives of its own database comes from a machine that holds the data, on the peer door alone. */
  if (method === 'PUT' && path.startsWith(PEER_PATHS.led) && UUID.test(path.slice(PEER_PATHS.led.length))) {
    return kind === 'peer' && role === 'data' ? { to: 'led', id: path.slice(PEER_PATHS.led.length) } : { to: 'refused', status: 403 };
  }
  /* A planned switch is between the keepers of machines that hold the data, on the peer door alone. */
  if ((method === 'GET' || method === 'POST') && path.startsWith(PEER_PATHS.switch)) {
    return kind === 'peer' && role === 'data' ? { to: 'switch', method, path } : { to: 'refused', status: 403 };
  }
  /* So are the word of the machine that leads about its update, the beats of the keepers, a keeper's ask for the next
     term, and the CEO's word of which copy to go on from, which go the same way. */
  if (method === 'POST' && (path === PEER_PATHS.updating || path === PEER_PATHS.beat || path === PEER_PATHS.promise || path === PEER_PATHS.goOn)) return kind === 'peer' && role === 'data' ? { to: 'switch', method, path } : { to: 'refused', status: 403 };
  return method === 'GET' && path === PEER_PATHS.hello ? { to: 'hello' } : { to: 'refused', status: 404 };
}

/* The reason this peer may not go on, in OpenSSL's words for the same two cases, or null when it may. */
export function refusalOf(peer: Peer, revoked: ReadonlySet<string>, now: Date): string | null {
  if (revoked.has(peer.serial)) return CERT_REVOKED;
  return peer.until > now ? null : CERT_HAS_EXPIRED;
}

/* Times come in order, so the oldest entries stand first and an address leaves once its minute is over: a scan from many
   addresses cannot fill the memory. */
export class OncePerMinute {
  private readonly last = new Map<string, number>();

  allows(key: string, at: number): boolean {
    for (const [seen, when] of this.last) {
      if (at - when < MINUTE_MS) break;
      this.last.delete(seen);
    }
    if (this.last.has(key)) return false;
    this.last.set(key, at);
    return true;
  }
}

function readPeer(socket: tls.TLSSocket, address: string): Peer | null {
  try {
    const facts = certFacts(String(socket.getPeerX509Certificate()));
    return { machine: facts.machineId, role: facts.role, serial: facts.serial, until: facts.notAfter, address };
  } catch {
    return null;
  }
}

function contextOf(held: HeldCertificate, key: MachineKey, crl: string): tls.SecureContextOptions {
  return {
    cert: held.certPem,
    key: key.privatePem,
    ca: held.authorityPem,
    crl,
    minVersion: 'TLSv1.3',
    secureOptions: constants.SSL_OP_NO_TICKET,
  };
}

function codeOf(err: unknown): string {
  return String((err as NodeJS.ErrnoException).code);
}

function isGone(stream: ServerHttp2Stream): boolean {
  return stream.destroyed || stream.closed;
}

function answerEmpty(stream: ServerHttp2Stream, status: number): void {
  if (!isGone(stream)) stream.respond({ ':status': status }, { endStream: true });
}

/* A stream that was answered is closed with whatever the peer still sends, once the answer has left: a reset sent ahead
   of an answer still waiting to be written takes the answer with it, and the peer would see its stream end unanswered.
   An answer that has not left after a while is one its peer does not read, and the stream is closed without it. */
export function cutOnceAnswered(stream: ServerHttp2Stream, looks = 0): void {
  if (stream.readableEnded || isGone(stream)) return;
  if (stream.state.localClose || looks > ANSWER_LEAVES_LOOKS) return void stream.close(http2.constants.NGHTTP2_NO_ERROR);
  if (looks === 0) setImmediate(() => cutOnceAnswered(stream, 1));
  else setTimeout(() => cutOnceAnswered(stream, looks + 1), ANSWER_LEAVES_MS).unref();
}

/* Plain pipes and not pipeline, which breaks the stream as soon as the far socket has left, while the peer's flow control
   may still hold back that socket's last bytes. A far side that finished ends the stream the clean way, and only one that
   broke resets it, so the peer can tell them apart. The stream itself stays until the peer ends its own side: a reset here
   would reach Node's client as an abort even with every byte delivered. */
function joinBothWays(stream: ServerHttp2Stream, far: Duplex, sent?: (bytes: number) => void): void {
  stream.pipe(far);
  far.pipe(stream);
  if (sent) far.on('data', (chunk: Buffer) => sent(chunk.length));
  stream.once('close', () => far.destroy());
  far.once('close', () => {
    if (!far.readableEnded) stream.close(http2.constants.NGHTTP2_CONNECT_ERROR);
    /* Nothing reads what the peer still sends, and a stream with unread bytes never closes. */
    stream.resume();
  });
}

/* What a peer sent on a stream, whole, when it is no longer than this; null for more, or for a stream that was cut. */
function bodyWithin(stream: ServerHttp2Stream, max: number): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (chunk: Buffer): void => {
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      stream.off('data', take);
      resolve(null);
    };
    stream.on('data', take);
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('close', () => resolve(null));
  });
}

async function tunnel(stream: ServerHttp2Stream, opening: Promise<Duplex>, sent?: (bytes: number) => void): Promise<void> {
  const far = await opening.catch(() => null);
  if (!far) return answerEmpty(stream, 502);
  far.on('error', ignore);
  if (isGone(stream)) {
    far.destroy();
    return;
  }
  stream.respond({ ':status': 200 });
  joinBothWays(stream, far, sent);
}

function closeServer(server: Http2SecureServer): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

export class PeerServer {
  private readonly servers: Http2SecureServer[] = [];
  private readonly waiting: Waiting[] = [];
  private readonly sessions = new Map<Http2Session, Peer>();
  private readonly sockets = new Set<net.Socket>();
  private readonly lineGate = new OncePerMinute();
  /* What this machine's database sent each peer, by the peer's machine. */
  private readonly toDb = new Map<string, number>();
  private readonly sent = new Map<string, number>();
  private sweeper: NodeJS.Timeout | undefined;
  /* Node ends a refused certificate's socket before it says so, and the socket no longer knows its address by then. The
     plain socket under it closes just before, in the same turn of the loop, so this is that address. */
  private lastClosed = '';

  constructor(private readonly opts: PeerServerOptions) {}

  listen(port: number, kind: Kind, host: string = ANY_ADDRESS): Promise<number> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ port, kind, host, resolve, reject });
      this.refresh();
    });
  }

  refresh(): void {
    const context = this.readContext();
    if (context) {
      for (const server of this.servers) server.setSecureContext(context);
      for (const waiting of this.waiting.splice(0)) this.open(waiting, context);
    }
    this.sweep();
  }

  /* Every byte written to each peer's streams so far, by the peer's machine: what its database sent it, an app's
     answers, bundles and hellos. How fast the leader sends to a machine is read from how this grows. */
  sentBytes(): ReadonlyMap<string, number> {
    return this.sent;
  }

  private count(peer: Peer, bytes: number): void {
    this.sent.set(peer.machine, (this.sent.get(peer.machine) ?? 0) + bytes);
  }

  /* The bytes this machine's database sent that machine on its streams since this server started: whether a copy still
     takes what it is sent. */
  dbBytes(machine: string): number {
    return this.toDb.get(machine) ?? 0;
  }

  close(): Promise<void> {
    clearInterval(this.sweeper);
    for (const waiting of this.waiting.splice(0)) waiting.reject(new Error(CLOSED));
    for (const socket of this.sockets) socket.destroy();
    return Promise.all(this.servers.splice(0).map(closeServer)).then(ignore);
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /* What OpenSSL cannot read changes nothing: what serves stays as it is, what waits goes on waiting, and the next refresh
     tries again. */
  private readContext(): tls.SecureContextOptions | null {
    const held = this.opts.held();
    const crl = this.opts.crl();
    if (!held || !crl) return null;
    const context = contextOf(held, this.opts.key, crl);
    try {
      tls.createSecureContext(context);
      return context;
    } catch (err) {
      this.sayOnce(CONTEXT_FAILURE, `The peer link could not read its certificate or its list: ${codeOf(err)}`);
      return null;
    }
  }

  private open(waiting: Waiting, context: tls.SecureContextOptions): void {
    const server = http2.createSecureServer({ ...context, requestCert: true, rejectUnauthorized: true, allowHTTP1: false });
    this.servers.push(server);
    /* It stays on: after the start an error is one failed accept, and the next peer should still get through. */
    server.on('error', waiting.reject);
    server.on('connection', socket => this.track(socket));
    server.on('tlsClientError', (err, socket) => this.onHandshakeFailed(err, socket));
    /* Node's own answer to a client that does not speak HTTP/2 is a page of text. */
    server.on('unknownProtocol', socket => socket.destroy());
    server.on('session', session => this.admit(session));
    server.on('stream', (stream, headers) => this.onStream(waiting.kind, stream, headers));
    server.listen(waiting.port, waiting.host, () => waiting.resolve((server.address() as AddressInfo).port));
    this.sweeper ??= setInterval(() => this.sweep(), this.opts.sweepMs ?? SWEEP_MS).unref();
  }

  private track(socket: net.Socket): void {
    const address = socket.remoteAddress ?? '';
    this.sockets.add(socket);
    socket.once('close', () => {
      this.sockets.delete(socket);
      this.lastClosed = address;
    });
  }

  private onHandshakeFailed(err: Error, socket: tls.TLSSocket): void {
    const reason = socket.authorizationError ?? codeOf(err);
    this.sayRefused(socket.remoteAddress ?? this.lastClosed, String(reason));
  }

  private sayRefused(address: string, reason: string): void {
    this.sayOnce(address, `The peer link refused ${address}: ${reason}`);
  }

  private sayOnce(key: string, line: string): void {
    if (this.lineGate.allows(key, this.now().getTime())) this.opts.log(line);
  }

  /* The second guard, on every connection that gets as far as a session: Node sets the session up as soon as the handshake
     is through, and a connection without one is destroyed above. */
  private admit(session: ServerHttp2Session): void {
    const socket = session.socket as tls.TLSSocket;
    const address = socket.remoteAddress ?? '';
    const peer = readPeer(socket, address);
    if (!peer) return this.refuse(session, address, NAMES_NO_MACHINE);
    const refusal = this.refusalNow(peer);
    if (refusal) return this.refuse(session, address, refusal);
    this.sessions.set(session, peer);
    session.once('close', () => this.sessions.delete(session));
  }

  private refuse(session: ServerHttp2Session, address: string, reason: string): void {
    this.sayRefused(address, reason);
    session.destroy();
  }

  private refusalNow(peer: Peer): string | null {
    return refusalOf(peer, this.opts.revoked(), this.now());
  }

  private sweep(): void {
    for (const [session, peer] of this.sessions) {
      if (this.refusalNow(peer)) session.destroy();
    }
  }

  private onStream(kind: Kind, stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void {
    stream.on('error', ignore);
    const session = stream.session;
    const peer = session && this.sessions.get(session);
    if (!peer || this.refusalNow(peer)) {
      session?.destroy();
      return;
    }
    this.answer(routeOf(headers, kind, peer.role, this.opts.db), stream, peer);
  }

  private answer(route: Route, stream: ServerHttp2Stream, peer: Peer): void {
    if (route.to === 'hello') return this.sayHello(stream, peer);
    if (route.to === 'app') return void tunnel(stream, this.opts.door.connect(peer), bytes => this.count(peer, bytes));
    if (route.to === 'db') {
      return void tunnel(stream, openTcp(route.db), bytes => {
        this.toDb.set(peer.machine, (this.toDb.get(peer.machine) ?? 0) + bytes);
        this.count(peer, bytes);
      });
    }
    if (route.to === 'bundle') return route.put ? void this.takeBundle(stream, peer, route.id) : this.giveBundle(stream, peer, route.id);
    if (route.to === 'file') return void (route.put ? this.takeFile(stream, peer, route.sha256) : this.giveFile(stream, peer, route.sha256));
    if (route.to === 'upload') return void this.takeUpload(stream, peer, route.id, route.length);
    if (route.to === 'switch') return void this.answerSwitch(stream, peer, route.method, route.path);
    if (route.to === 'led') return void this.takeLed(stream, peer, route.id);
    answerEmpty(stream, route.status);
  }

  /* A path of a planned switch: its body is read whole, as JSON and no longer than a hello, and what handles it gives
     the answer. What it wants done after the answer is done once the stream that carried it has ended, and at once
     when that stream was gone before the answer: what was asked is done by then, whether or not the peer hears it. */
  private async answerSwitch(stream: ServerHttp2Stream, peer: Peer, method: 'GET' | 'POST', path: string): Promise<void> {
    const { switches } = this.opts;
    if (!switches) return answerEmpty(stream, 404);
    let body: unknown;
    if (method === 'POST') {
      const sent = await bodyWithin(stream, SWITCH_BODY_BYTES);
      try {
        if (!sent) throw new Error('too long, or cut');
        body = JSON.parse(sent.toString());
      } catch {
        answerEmpty(stream, 400);
        /* Whatever the peer still sends is not read. */
        cutOnceAnswered(stream);
        return;
      }
    }
    const answer = await switches.handle(peer, method, path, body).catch(() => null);
    if (isGone(stream)) return answer?.after?.();
    if (!answer) return answerEmpty(stream, 500);
    const said = JSON.stringify(answer.body);
    if (answer.after) stream.once('close', answer.after);
    stream.respond({ ':status': answer.status, 'content-type': 'application/json' });
    this.count(peer, Buffer.byteLength(said));
    stream.end(said);
  }

  /* A bundle goes to a machine picked to hold it, with its length said first. A peer that leaves ends the reading. */
  private giveBundle(stream: ServerHttp2Stream, peer: Peer, id: string): void {
    const found = this.opts.backups?.get(peer, id) ?? { status: 404 as const };
    if (found.status !== 200) return answerEmpty(stream, found.status);
    const bundle = found.stream();
    bundle.on('error', () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
    stream.once('close', () => bundle.destroy());
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream', 'content-length': found.length });
    bundle.on('data', (chunk: Buffer) => this.count(peer, chunk.length));
    bundle.pipe(stream);
  }

  /* A bundle comes back from a machine that holds it. What takes it reads a copy of the stream and may cut that at any
     moment, while the stream itself stays for the answer; then it is closed with whatever the peer still sends, so one
     that is refused is cut as soon as it has its answer. */
  private async takeBundle(stream: ServerHttp2Stream, peer: Peer, id: string): Promise<void> {
    const body = new PassThrough();
    body.on('error', ignore);
    stream.pipe(body);
    stream.once('close', () => body.destroy());
    const status = this.opts.backups ? await this.opts.backups.put(peer, id, body).catch(() => 400 as const) : 404;
    stream.unpipe(body);
    body.destroy();
    answerEmpty(stream, status);
    cutOnceAnswered(stream);
  }

  /* A sealed file goes to a machine that holds the company's files, as a bundle does. */
  private async giveFile(stream: ServerHttp2Stream, peer: Peer, sha256: string): Promise<void> {
    const found = (await this.opts.files?.get(peer, sha256).catch(() => null)) ?? { status: 404 as const };
    if (stream.destroyed) return;
    if (found.status !== 200) return answerEmpty(stream, found.status);
    const file = found.stream();
    file.on('error', () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
    stream.once('close', () => file.destroy());
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream', 'content-length': found.length });
    file.on('data', (chunk: Buffer) => this.count(peer, chunk.length));
    file.pipe(stream);
  }

  /* A file this machine asked for comes back from one that holds it, taken as a bundle that comes back is. */
  private async takeFile(stream: ServerHttp2Stream, peer: Peer, sha256: string): Promise<void> {
    const body = new PassThrough();
    body.on('error', ignore);
    stream.pipe(body);
    stream.once('close', () => body.destroy());
    const status = this.opts.files ? await this.opts.files.put(peer, sha256, body).catch(() => 400) : 404;
    stream.unpipe(body);
    body.destroy();
    answerEmpty(stream, status);
    cutOnceAnswered(stream);
  }

  /* The bundle of a database that led, taken as the bundle above is; the answer is how its record went. */
  private async takeLed(stream: ServerHttp2Stream, peer: Peer, id: string): Promise<void> {
    const body = new PassThrough();
    body.on('error', ignore);
    stream.pipe(body);
    stream.once('close', () => body.destroy());
    const status = this.opts.leds ? await this.opts.leds.put(peer, id, body).catch(() => 400) : 404;
    stream.unpipe(body);
    body.destroy();
    answerEmpty(stream, status);
    cutOnceAnswered(stream);
  }

  /* What a machine held when it stopped holding the company's data comes here. It is taken as the bundle above is: what
     takes it reads a copy of the stream, and a machine that is refused, or sends too much, is cut as soon as it has its
     answer. The machine says first how long it is: a stream that a peer cut ends here as one that was sent whole does. */
  private async takeUpload(stream: ServerHttp2Stream, peer: Peer, id: string, length: number | null): Promise<void> {
    const body = new PassThrough();
    body.on('error', ignore);
    stream.pipe(body);
    stream.once('close', () => body.destroy());
    const status = this.opts.uploads ? await this.opts.uploads.put(peer, id, body, length).catch(() => 400 as const) : 404;
    stream.unpipe(body);
    body.destroy();
    answerEmpty(stream, status);
    cutOnceAnswered(stream);
  }

  private sayHello(stream: ServerHttp2Stream, peer: Peer): void {
    const said = JSON.stringify({ ...this.opts.hello(peer), seen: peer.address });
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    this.count(peer, Buffer.byteLength(said));
    stream.end(said);
  }
}
