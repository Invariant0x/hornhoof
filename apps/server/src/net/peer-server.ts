import { constants } from 'node:crypto';
import http2 from 'node:http2';
import type { Http2SecureServer, Http2Session, IncomingHttpHeaders, ServerHttp2Session, ServerHttp2Stream } from 'node:http2';
import type net from 'node:net';
import type { AddressInfo } from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import tls from 'node:tls';
import type { PeerBackups } from '../modules/keeper/backups.js';
import type { HeldCertificate } from '../modules/keeper/certificate.js';
import type { MachineKey } from '../modules/keeper/machine-keys.js';
import { certFacts } from '../modules/network/authority.js';
import type { MachineRole } from '../db/schema.js';
import { openTcp } from './peer-door.js';
import { UUID, type Target } from './proxy.js';

export const PEER_PATHS = { hello: '/peer/hello', backups: '/peer/backups/' } as const;
export const APP_AUTHORITY = 'app:8080';
export const DB_AUTHORITY = 'db:5432';

export type Peer = { machine: string; role: MachineRole; serial: string; until: Date; address: string };
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
  log: (line: string) => void;
  now?: () => Date;
  sweepMs?: number;
};
type Kind = 'peer' | 'app';
type Route = { to: 'hello' } | { to: 'app' } | { to: 'db'; db: Target } | { to: 'bundle'; id: string; put: boolean } | { to: 'refused'; status: 403 | 404 };
type Waiting = { port: number; kind: Kind; host: string; resolve: (port: number) => void; reject: (err: Error) => void };

const SWEEP_MS = 5000;
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
    if (route.to === 'app') return void tunnel(stream, this.opts.door.connect(peer));
    if (route.to === 'db') return void tunnel(stream, openTcp(route.db), bytes => this.toDb.set(peer.machine, (this.toDb.get(peer.machine) ?? 0) + bytes));
    if (route.to === 'bundle') return route.put ? void this.takeBundle(stream, peer, route.id) : this.giveBundle(stream, peer, route.id);
    answerEmpty(stream, route.status);
  }

  /* A bundle goes to a machine picked to hold it, with its length said first. A peer that leaves ends the reading. */
  private giveBundle(stream: ServerHttp2Stream, peer: Peer, id: string): void {
    const found = this.opts.backups?.get(peer, id) ?? { status: 404 as const };
    if (found.status !== 200) return answerEmpty(stream, found.status);
    const bundle = found.stream();
    bundle.on('error', () => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR));
    stream.once('close', () => bundle.destroy());
    stream.respond({ ':status': 200, 'content-type': 'application/octet-stream', 'content-length': found.length });
    bundle.pipe(stream);
  }

  /* A bundle comes back from a machine that holds it. What takes it reads a copy of the stream and may cut that at any
     moment, while the stream itself stays for the answer; then it is closed with whatever the peer still sends, so one
     that is refused is cut at once. */
  private async takeBundle(stream: ServerHttp2Stream, peer: Peer, id: string): Promise<void> {
    const body = new PassThrough();
    body.on('error', ignore);
    stream.pipe(body);
    stream.once('close', () => body.destroy());
    const status = this.opts.backups ? await this.opts.backups.put(peer, id, body).catch(() => 400 as const) : 404;
    stream.unpipe(body);
    body.destroy();
    answerEmpty(stream, status);
    if (!stream.readableEnded && !isGone(stream)) stream.close(http2.constants.NGHTTP2_NO_ERROR);
  }

  private sayHello(stream: ServerHttp2Stream, peer: Peer): void {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ ...this.opts.hello(peer), seen: peer.address }));
  }
}
