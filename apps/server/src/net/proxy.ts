import http from 'node:http';
import { pipeline, type Duplex } from 'node:stream';

export type Target = { host: string; port: number };
export type Refusal = { status: number; headers: Record<string, string>; body: string };
export type PassOptions = {
  target: Target;
  /* What this hop adds, read from the request as it came in. */
  headers: (req: http.IncomingMessage) => Promise<Record<string, string>> | Record<string, string>;
  /* The answer to a request or an upgrade the target did not take: refused, reset before an answer, or not
     connected within connectMs. */
  unreachable: (req: http.IncomingMessage) => Refusal;
  connectMs?: number;
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
const STARTING_TEXT =
  'Hornhoof is starting. Try again in a few seconds.\nHornhoof запускается. Попробуйте еще раз через несколько секунд.\n';

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

function passedHeaders(req: http.IncomingMessage, added: Record<string, string>): http.OutgoingHttpHeaders {
  const endsHere = hopByHop(req);
  const kept = Object.entries(req.headers).filter(
    ([name]) => !endsHere(name) && !FORWARDING.has(name) && !name.startsWith('x-hornhoof-'),
  );
  return { ...Object.fromEntries(kept), ...framingOf(req), ...added };
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

/* Opens the target's end. Nothing here tries again: a request the target may have seen goes out once. */
function openTarget(opts: PassOptions, req: http.IncomingMessage, added: Record<string, string>, asker: Asker): http.ClientRequest {
  const headers = asker.headers(added);
  const out = http.request({ ...opts.target, method: req.method, path: req.url, headers, agent: false });
  limitConnect(out, opts.connectMs ?? CONNECT_MS);
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
      res.end(refusal.body);
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

function spliceSockets(client: Duplex, target: Duplex): void {
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
    if (!asker.side.destroyed) asker.carry(openTarget(opts, req, added, asker));
  } catch {
    /* Nothing read what the client sent, and this connection serves no other request after it. */
    asker.refuse(closing(opts.unreachable(req)));
  }
}

export function passThrough(opts: PassOptions): Handlers {
  return {
    request: (req, res) => void pass(opts, req, askerOfRequest(req, res)),
    upgrade: (req, socket, head) => {
      /* Node takes its own error handler off a socket it hands over, and an error with no handler ends the process. Both
         this and the reading start here, before anything is awaited, so that a client gone by then is seen. */
      socket.on('error', ignore);
      const takeEarly = holdEarlyBytes(socket, head);
      void pass(opts, req, askerOfUpgrade(req, socket, takeEarly));
    },
  };
}

export function socketAddress(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

export function firstForwarded(req: http.IncomingMessage): string {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
}

export function startingAnswer(req: http.IncomingMessage): Refusal {
  const headers = { 'Retry-After': '5' };
  return UNDER_API_OR_MCP.test(String(req.url))
    ? { status: 502, headers: { ...headers, 'Content-Type': 'application/json' }, body: STARTING_JSON }
    : { status: 502, headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: STARTING_TEXT };
}

/* Both timeouts are given, since requestTimeout 0 alone also turns headersTimeout off on Node 22. */
export function serve(handlers: Handlers): http.Server {
  const options = { requestTimeout: 0, headersTimeout: HEADERS_MS, keepAliveTimeout: KEEP_ALIVE_MS };
  const server = http.createServer(options, handlers.request);
  server.on('upgrade', handlers.upgrade);
  return server;
}
