import http from 'node:http';
import net from 'node:net';
import { pipeline, type Duplex } from 'node:stream';
import { awayEveryS, awayLine, awayPage, type Away } from './away-page.js';

export type Target = { host: string; port: number };
export type Refusal = { status: number; headers: Record<string, string>; body: string };
export type PassOptions = {
  target: Target;
  /* What this hop adds, read from the request as it came in. */
  headers: (req: http.IncomingMessage) => Promise<Record<string, string>> | Record<string, string>;
  /* The answer to a request or an upgrade the target did not take: refused, reset before an answer, or not
     connected within connectMs. */
  unreachable: (req: http.IncomingMessage) => Refusal;
  /* What this hop answers by itself, with nothing passed on. Null: the request goes to the target. An upgrade always goes. */
  own?: (req: http.IncomingMessage) => Refusal | null;
  /* What this hop turns away whichever way it was asked, a request or an upgrade, before anything else is looked at.
     Null: it is not turned away. */
  closed?: (req: http.IncomingMessage) => Refusal | null;
  connectMs?: number;
  /* For how long a request whose connect to the target fails is held and tried again, counted from when it came. Nothing
     of the request is read before the target connects. 0 or not given: it is answered unreachable at once. Whoever sent
     the request may ask for a shorter hold with the header HOLD, as a hop that holds it too does. */
  holdMs?: number;
  /* The pause between two tries of a held request. */
  holdEveryMs?: number;
  /* Asked before each new try: an answer ends the hold with it, as when the hop knows the wait will be long. */
  holding?: (req: http.IncomingMessage) => Refusal | null;
  /* The answer once the hold ran out; heldAnswer when not given. */
  held?: (req: http.IncomingMessage) => Refusal;
};
type Handlers = {
  request: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  upgrade: (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void;
};
/* The side that asked, whichever way it asked. */
type Asker = {
  /* The client's end: it says whether the client is still there, and tells when it goes. */
  side: NodeJS.EventEmitter & { destroyed: boolean };
  headers: (added: Record<string, string>) => http.OutgoingHttpHeaders;
  refuse: (refusal: Refusal) => void;
  answer: (up: http.IncomingMessage) => void;
  carry: (out: http.ClientRequest) => void;
};

const CONNECT_MS = 5000;
/* How long front holds a request while the keeper is away, and the keeper while the app is: the keeper's is shorter, so
   that its answer reaches front, and the page, inside front's minute. */
export const HOLD_MS = 60_000;
export const KEEPER_HOLD_MS = 45_000;
const HOLD_EVERY_MS = 500;
/* The milliseconds a hop before this one still has for the request: this hop holds it no longer than that. */
export const HOLD = 'x-hornhoof-hold';
/* The id front stamps a tool call with, the same on every try of that call. */
export const INVOCATION = 'x-hornhoof-invocation';
/* A lowercase uuid, as ids travel in Hornhoof's own headers. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* How long this request is held: this hop's own time, or the shorter one its sender asked for. */
function holdOf(opts: PassOptions, req: http.IncomingMessage): number {
  const own = opts.holdMs ?? 0;
  const asked = String(req.headers[HOLD] ?? '');
  return /^\d{1,9}$/.test(asked) ? Math.min(own, Number(asked)) : own;
}
/* A WebSocket client sends nothing until the 101, so this is room to spare, and it keeps a flood out of memory. */
const EARLY_BYTES = 64 * 1024;
/* What clients have today, Fastify's default. With Node's 5 s a client reusing a connection just as it closes gets a reset. */
const KEEP_ALIVE_MS = 72_000;
/* Also what clients have today. It may sit below the keep-alive, since Node counts it only from a request's first byte. */
const HEADERS_MS = 60_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const FORWARDING = new Set(['x-forwarded-for', 'x-forwarded-proto']);
const UNDER_API_OR_MCP = /^\/(?:api\/|mcp(?:[/?]|$))/;
const STARTING_JSON = JSON.stringify({ error: { code: 'unavailable', message: 'Hornhoof is starting.', reason: 'starting' } });
const HELD_JSON = JSON.stringify({ error: { code: 'unavailable', message: 'Hornhoof did not answer for a minute. Try again in a few seconds.', reason: 'starting' } });

const ignore = (): void => {};

function pairsOf(raw: string[]): [string, string][] {
  return raw.flatMap((name, index): [string, string][] => (index % 2 === 0 ? [[name, raw[index + 1]]] : []));
}

/* The headers that end at this hop: the fixed ones, and whatever else this message's Connection names. */
function hopByHop(message: http.IncomingMessage): (name: string) => boolean {
  const listed = (message.headers.connection || '').toLowerCase().split(',').map(name => name.trim());
  return name => HOP_BY_HOP.has(name) || listed.includes(name);
}

/* How the next hop finds the end of the body. It is this hop's own and no list in Connection takes it away: without it
   the body of a GET or a DELETE would reach the target as the next request on the connection, with headers nobody here
   looked at. */
function framingOf(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const { 'content-length': length, 'transfer-encoding': encoding } = req.headers;
  if (encoding) return { 'transfer-encoding': 'chunked' };
  return length ? { 'content-length': length } : {};
}

/* Hornhoof's own headers say who a request is from, so none that came in goes on. The stamp and the signature of a
   delivery receipt do: a sender outside signs them, and only the check of that signature believes them. So does the
   proof a machine that survived the loss of its server sends with each bundle, which is made from a number only the
   recovery file's holder could read. */
export const RECOVERY_PROOF = 'x-hornhoof-recovery';
const SIGNED_OUTSIDE: ReadonlySet<string> = new Set(['x-hornhoof-timestamp', 'x-hornhoof-signature', RECOVERY_PROOF]);
const hornhoofsOwn = (name: string): boolean => name.startsWith('x-hornhoof-') && !SIGNED_OUTSIDE.has(name);

/* What of a request's headers goes on to the next hop: none that ends at this one, none that says who the request is
   from, and none of Hornhoof's own. The framing of the body is for the caller to add. */
export function hopHeaders(req: http.IncomingMessage): http.OutgoingHttpHeaders {
  const endsHere = hopByHop(req);
  const framing = (name: string): boolean => name === 'content-length';
  return Object.fromEntries(Object.entries(req.headers).filter(([name]) => !endsHere(name) && !FORWARDING.has(name) && !hornhoofsOwn(name) && !framing(name)));
}

function passedHeaders(req: http.IncomingMessage, added: Record<string, string>): http.OutgoingHttpHeaders {
  return { ...hopHeaders(req), ...framingOf(req), ...added };
}

function answerHeaders(up: http.IncomingMessage): string[] {
  const endsHere = hopByHop(up);
  return pairsOf(up.rawHeaders)
    .filter(([name]) => !endsHere(name.toLowerCase()))
    .flat();
}

function lengthOf(refusal: Refusal): Record<string, string> {
  return { ...refusal.headers, 'Content-Length': String(Buffer.byteLength(refusal.body)) };
}

function limitConnect(out: http.ClientRequest, ms: number): void {
  const giveUp = setTimeout(() => out.destroy(), ms);
  const stop = () => clearTimeout(giveUp);
  out.once('socket', socket => socket.once('connect', stop));
  out.once('close', stop);
}

/* A connection to the target, or null when it was refused, not found, out of reach or not made within ms. */
function connectTo(target: Target, ms: number): Promise<net.Socket | null> {
  return new Promise(resolve => {
    const socket = net.connect(target.port, target.host);
    const giveUp = setTimeout(() => socket.destroy(), ms);
    socket.once('connect', () => {
      clearTimeout(giveUp);
      socket.off('close', failed);
      resolve(socket);
    });
    const failed = () => {
      clearTimeout(giveUp);
      resolve(null);
    };
    socket.on('error', ignore);
    socket.once('close', failed);
  });
}

/* A pause between two tries, cut short when the client goes. */
function pauseOrGone(side: Asker['side'], ms: number): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      side.off('close', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    side.once('close', done);
  });
}

/* Tries to connect until the target takes the connection, the hold runs out, the hop says the wait is over, or the client
   goes. A connection: the request goes out on it. A refusal: the answer. Null: nobody is left to answer. Only a connect
   that failed is tried again, so a request the target may have seen still goes out once. */
async function heldConnection(opts: PassOptions, req: http.IncomingMessage, asker: Asker, holdMs: number): Promise<net.Socket | Refusal | null> {
  const until = Date.now() + holdMs;
  const every = opts.holdEveryMs ?? HOLD_EVERY_MS;
  for (;;) {
    const socket = await connectTo(opts.target, opts.connectMs ?? CONNECT_MS);
    if (asker.side.destroyed) {
      socket?.destroy();
      return null;
    }
    if (socket) return socket;
    const over = opts.holding?.(req);
    if (over) return over;
    if (Date.now() + every > until) return (opts.held ?? heldAnswer)(req);
    await pauseOrGone(asker.side, every);
    if (asker.side.destroyed) return null;
  }
}

/* Opens the target's end, on a connection already made when the request was held for one. Nothing here tries again: a
   request the target may have seen goes out once. */
function openTarget(opts: PassOptions, req: http.IncomingMessage, added: Record<string, string>, asker: Asker, socket?: net.Socket): http.ClientRequest {
  const headers = asker.headers(added);
  /* Node uses a connection given to it only when the request has no agent at all; with one, the agent opens its own. */
  const connection = socket ? { createConnection: () => socket } : { agent: false as const };
  const out = http.request({ ...opts.target, method: req.method, path: req.url, headers, ...connection });
  if (!socket) limitConnect(out, opts.connectMs ?? CONNECT_MS);
  const fail = () => asker.refuse(opts.unreachable(req));
  out.on('error', ignore);
  out.once('error', fail);
  const detach = () => {
    out.off('error', fail);
    asker.side.off('close', abandon);
  };
  /* A client that left is not a target that failed, and there is nobody to refuse. */
  const abandon = () => {
    detach();
    out.destroy();
  };
  asker.side.once('close', abandon);
  /* Also after a 101: the sockets are spliced by then, and this request has nothing left to close. */
  out.once('close', detach);
  out.once('response', up => {
    out.off('error', fail);
    try {
      asker.answer(up);
    } catch {
      /* An answer this hop cannot write, such as a status below 100, counts as none, and must not end the process. */
      fail();
    }
  });
  return out;
}

function askerOfRequest(req: http.IncomingMessage, res: http.ServerResponse): Asker {
  return {
    side: res,
    headers: added => passedHeaders(req, added),
    refuse: refusal => {
      res.writeHead(refusal.status, lengthOf(refusal));
      if (req.complete || req.destroyed || refusal.headers.Connection === 'close') return void res.end(refusal.body);
      /* The client still sends, and what it sends is being read. The whole answer goes out now, but ending it lets the
         server close the connection, and a client cut while it sends sees the cut, not the answer: so the end waits
         for the rest of what it sends. A refusal that closes is for a request nothing reads, and ends at once. */
      res.write(refusal.body);
      req.resume();
      req.once('close', () => res.end());
    },
    answer: up => {
      res.writeHead(up.statusCode!, up.statusMessage, answerHeaders(up));
      res.flushHeaders();
      pipeline(up, res, ignore);
    },
    carry: out => {
      req.pipe(out);
      /* After the pipe's own listener, which pauses the request. The target may answer before an upload is done, and
         the client reads that answer only once it has sent the rest, so the rest is read and thrown away. */
      out.once('close', () => req.resume());
    },
  };
}

function headOf(status: number | undefined, message: string | undefined, raw: string[]): string {
  const lines = pairsOf(raw).map(([name, value]) => `${name}: ${value}\r\n`);
  return `HTTP/1.1 ${status} ${message}\r\n${lines.join('')}\r\n`;
}

/* What is already written still goes out; then the socket closes whatever the other end does. */
function closeAfterFlush(socket: Duplex, last?: string): void {
  socket.end(last, () => socket.destroy());
}

/* Joins two connections, byte for byte, each closing once the other has, with what was written still going out. */
export function spliceSockets(client: Duplex, target: Duplex): void {
  target.on('error', ignore);
  client.once('close', () => closeAfterFlush(target));
  target.once('close', () => closeAfterFlush(client));
  client.pipe(target);
  target.pipe(client);
}

/* Until the 101 nothing else reads the client's socket. It is read here because a close shows only once what came ahead
   of it is read, and it is acted on here because this socket keeps its half open and would stay so. What comes belongs
   to the target, which cannot take it yet. Pausing at the limit would hide the close again, so a client past it is cut. */
function holdEarlyBytes(client: Duplex, head: Buffer): () => Buffer {
  const held = [head];
  let size = 0;
  const hold = (chunk: Buffer) => {
    held.push(chunk);
    size += chunk.length;
    if (size > EARLY_BYTES) client.destroy();
  };
  const leave = () => client.destroy();
  client.on('data', hold);
  client.once('end', leave);
  return () => {
    client.off('data', hold);
    client.off('end', leave);
    return Buffer.concat(held);
  };
}

function askerOfUpgrade(req: http.IncomingMessage, client: Duplex, takeEarly: () => Buffer): Asker {
  return {
    side: client,
    headers: added => ({ ...passedHeaders(req, added), connection: 'Upgrade', upgrade: req.headers.upgrade }),
    refuse: refusal => {
      const headers = Object.entries({ ...lengthOf(refusal), Connection: 'close' }).flat();
      closeAfterFlush(client, headOf(refusal.status, http.STATUS_CODES[refusal.status], headers) + refusal.body);
    },
    answer: up => {
      client.write(headOf(up.statusCode, up.statusMessage, [...answerHeaders(up), 'Connection', 'close']), 'latin1');
      pipeline(up, client, () => client.destroy());
    },
    carry: out => {
      out.once('upgrade', (up, target, targetHead) => {
        client.write(headOf(up.statusCode, up.statusMessage, up.rawHeaders), 'latin1');
        client.write(targetHead);
        target.write(takeEarly());
        spliceSockets(client, target);
      });
      out.end();
    },
  };
}

function closing(refusal: Refusal): Refusal {
  return { ...refusal, headers: { ...refusal.headers, Connection: 'close' } };
}

async function pass(opts: PassOptions, req: http.IncomingMessage, asker: Asker): Promise<void> {
  try {
    const added = await opts.headers(req);
    if (asker.side.destroyed) return;
    const holdMs = holdOf(opts, req);
    if (!holdMs) return asker.carry(openTarget(opts, req, added, asker));
    const reached = await heldConnection(opts, req, asker, holdMs);
    if (!reached) return;
    if ('status' in reached) return asker.refuse(closing(reached));
    asker.carry(openTarget(opts, req, added, asker, reached));
  } catch {
    /* Nothing read what the client sent, and this connection serves no other request after it. */
    asker.refuse(closing(opts.unreachable(req)));
  }
}

export function passThrough(opts: PassOptions): Handlers {
  return {
    request: (req, res) => {
      const asker = askerOfRequest(req, res);
      const own = opts.closed?.(req) ?? opts.own?.(req);
      if (!own) return void pass(opts, req, asker);
      req.resume();
      asker.refuse(own);
    },
    upgrade: (req, socket, head) => {
      /* Node takes its own error handler off a socket it hands over, and an error with no handler ends the process. Both
         this and the reading start here, before anything is awaited, so that a client gone by then is seen. */
      socket.on('error', ignore);
      const takeEarly = holdEarlyBytes(socket, head);
      const asker = askerOfUpgrade(req, socket, takeEarly);
      const shut = opts.closed?.(req);
      if (shut) return void asker.refuse(shut);
      void pass(opts, req, asker);
    },
  };
}

export function socketAddress(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function firstForwarded(req: http.IncomingMessage): string {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

/* Who asks: a program for data under /api or /mcp, a browser for a page, any other client for plain words. A page is only
   for a browser that says it takes one, so a program that reads the words stays with them. */
export type Asks = 'data' | 'page' | 'words';
export function asksFor(req: http.IncomingMessage): Asks {
  if (UNDER_API_OR_MCP.test(String(req.url))) return 'data';
  const reads = req.method === 'GET' || req.method === 'HEAD';
  return reads && String(req.headers.accept ?? '').includes('text/html') ? 'page' : 'words';
}

/* What a hop answers when no server is behind it, to whoever asks: JSON for a program, the page of away-page.ts for a
   browser, the one English line of that page as text for the rest. Never 404: the status says the server is missing, so the
   app tells it from a page that is. */
export function awayAnswer(req: http.IncomingMessage, answer: { status: number; kind: Away; retryS: number; json: string }): Refusal {
  const headers = { 'Retry-After': String(answer.retryS) };
  switch (asksFor(req)) {
    case 'data': return { status: answer.status, headers: { ...headers, 'Content-Type': 'application/json' }, body: answer.json };
    case 'page': return { status: answer.status, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: awayPage(answer.kind) };
    case 'words': return { status: answer.status, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: `${awayLine(answer.kind)}\n` };
  }
}

export function startingAnswer(req: http.IncomingMessage): Refusal {
  return awayAnswer(req, { status: 502, kind: 'lost', retryS: 5, json: STARTING_JSON });
}

/* What a hop answers once it held a request for as long as it holds one. */
export function heldAnswer(req: http.IncomingMessage): Refusal {
  return awayAnswer(req, { status: 503, kind: 'lost', retryS: 5, json: HELD_JSON });
}

/* What the keeper answers while an update installs and takes no changes. */
export function updatingAnswer(req: http.IncomingMessage, json: string): Refusal {
  return awayAnswer(req, { status: 503, kind: 'updating', retryS: awayEveryS('updating'), json });
}

/* Both timeouts are given, since requestTimeout 0 alone also turns headersTimeout off on Node 22. */
export function serve(handlers: Handlers): http.Server {
  const options = { requestTimeout: 0, headersTimeout: HEADERS_MS, keepAliveTimeout: KEEP_ALIVE_MS };
  const server = http.createServer(options, handlers.request);
  server.on('upgrade', handlers.upgrade);
  return server;
}
