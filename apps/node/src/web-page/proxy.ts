import { timingSafeEqual } from 'node:crypto';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { pipeline, Transform, type Duplex } from 'node:stream';
import { ONLY_WEB, vetHost, type Lookup, type Vetted } from './address.js';

/* Every request of the browser goes through this proxy, which the run starts for itself on the loopback address. It looks
   each name up itself and connects only to an address it vetted, so neither a redirect, nor a page's script, nor a name that
   answers with an inside address later can lead the browser inside. It never follows a redirect itself: the browser asks
   for the next hop, which is vetted again. */

export const REFUSED_HEADER = 'x-hornhoof-refused';
export type Dial = (address: string, port: number) => Socket;
export type Refused = { host: string; reason: string };
type ProxyOptions = {
  lookup: Lookup;
  maxBytes: number;
  credentials: { username: string; password: string };
  dial?: Dial;
  listen?: (server: Server) => Promise<number>;
};
export type Proxy = { port: number; refused: Refused[]; received(): number; overLimit(): boolean; close(): Promise<void> };

export const SIZE_LIMIT = 'the size limit of this call was reached';
const MAX_REFUSALS = 100;
/* What concerns only one hop, the proxy's own credentials among it. */
const HOP = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const dialDirect: Dial = (address, port) => connect({ host: address, port });
const listenLocal = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
});

const bare = (host: string): string => host.replace(/^\[|\]$/g, '');
const oneHop = (headers: IncomingHttpHeaders): IncomingHttpHeaders =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name.toLowerCase())));

/* host:port of a CONNECT, or null. */
function target(text: string | undefined): { host: string; port: number } | null {
  const found = /^(\[[0-9a-fA-F:.]+\]|[^:[\]/\s]+):(\d{1,5})$/.exec(text ?? '');
  const port = Number(found?.[2]);
  return found && port >= 1 && port <= 65535 ? { host: found[1]!, port } : null;
}

/* What the proxy of one call keeps: its rules, what it refused, the open sockets and what the sites sent. */
type State = {
  lookup: Lookup;
  maxBytes: number;
  dial: Dial;
  expected: Buffer;
  refused: Refused[];
  sockets: Set<Duplex>;
  received: number;
  over: boolean;
};

const keep = <T extends Duplex>(state: State, socket: T): T => {
  state.sockets.add(socket);
  socket.once('close', () => state.sockets.delete(socket));
  return socket;
};

function authorized(state: State, req: IncomingMessage): boolean {
  const given = Buffer.from(req.headers['proxy-authorization'] ?? '');
  return given.length === state.expected.length && timingSafeEqual(given, state.expected);
}

function record(state: State, host: string, reason: string): void {
  if (state.refused.length < MAX_REFUSALS) state.refused.push({ host: bare(host), reason });
}

/* Counts what the sites send, and stops the stream that goes past the limit. */
function meter(state: State): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      state.received += chunk.length;
      if (state.received <= state.maxBytes) return done(null, chunk);
      state.over = true;
      done(new Error(SIZE_LIMIT));
    },
  });
}

const vet = async (state: State, host: string): Promise<Vetted> => (state.over ? { ok: false, reason: SIZE_LIMIT } : vetHost(host, state.lookup));

function refuse(state: State, res: ServerResponse, host: string, reason: string): void {
  record(state, host, reason);
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', [REFUSED_HEADER]: reason });
  res.end(`Hornhoof's browser does not open ${bare(host)}: ${reason}.\n`);
}

function refuseSocket(state: State, socket: Duplex, host: string, reason: string): void {
  record(state, host, reason);
  socket.end(`HTTP/1.1 403 Forbidden\r\n${REFUSED_HEADER}: ${reason}\r\nContent-Length: 0\r\n\r\n`);
}

function askCredentials(socket: Duplex): void {
  socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="hh-browse"\r\nContent-Length: 0\r\n\r\n');
}

/* The address of a plain http request, which the browser sends whole; null for one that is not an address. */
function urlOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '');
  } catch {
    return null;
  }
}

/* The request to the vetted address, and its answer back through the meter. */
function sendOn(state: State, req: IncomingMessage, res: ServerResponse, url: URL, address: string): void {
  const port = Number(url.port || 80);
  const upstream = request({
    method: req.method,
    path: `${url.pathname}${url.search}`,
    headers: oneHop(req.headers),
    setHost: false,
    createConnection: () => keep(state, state.dial(address, port)),
  });
  upstream.on('response', answer => {
    res.writeHead(answer.statusCode ?? 502, oneHop(answer.headers));
    pipeline(answer, meter(state), res, failed => { if (failed) { res.destroy(); upstream.destroy(); } });
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The site could not be reached.\n');
  });
  req.pipe(upstream);
}

async function forward(state: State, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(state, req)) {
    res.writeHead(407, { 'proxy-authenticate': 'Basic realm="hh-browse"', 'content-length': '0' });
    return void res.end();
  }
  const url = urlOf(req);
  if (!url) {
    res.writeHead(400, { 'content-length': '0' });
    return void res.end();
  }
  if (url.protocol !== 'http:') return refuse(state, res, url.hostname || url.protocol, ONLY_WEB);
  const vetted = await vet(state, url.hostname);
  if (!vetted.ok) return refuse(state, res, url.hostname, vetted.reason);
  sendOn(state, req, res, url, vetted.addresses[0]!);
}

async function tunnel(state: State, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
  if (!authorized(state, req)) return askCredentials(socket);
  const to = target(req.url);
  if (!to) return void socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  const vetted = await vet(state, to.host);
  if (!vetted.ok) return refuseSocket(state, socket, to.host, vetted.reason);
  const upstream = keep(state, state.dial(vetted.addresses[0]!, to.port));
  upstream.once('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
  upstream.once('connect', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    pipeline(upstream, meter(state), socket, failed => { if (failed) { socket.destroy(); upstream.destroy(); } });
    socket.pipe(upstream);
  });
}

export async function startProxy({ lookup, maxBytes, credentials, dial = dialDirect, listen = listenLocal }: ProxyOptions): Promise<Proxy> {
  const expected = Buffer.from(`Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`);
  const state: State = { lookup, maxBytes, dial, expected, refused: [], sockets: new Set(), received: 0, over: false };
  const server = createServer((req, res) => { void forward(state, req, res); });
  server.on('connection', socket => keep(state, socket));
  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => { void tunnel(state, req, socket, head); });
  /* A WebSocket asked of the proxy itself; the browser opens one through a tunnel. */
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if (!authorized(state, req)) return askCredentials(socket);
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
  });
  server.on('clientError', (_error, socket: Duplex) => { socket.destroy(); });
  const port = await listen(server);

  return {
    port,
    refused: state.refused,
    received: () => state.received,
    overLimit: () => state.over,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve());
      for (const socket of state.sockets) socket.destroy();
    }),
  };
}
