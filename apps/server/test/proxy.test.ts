import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dns from 'node:dns';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex, Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { eventually } from '../../../test-support/eventually.mjs';
import {
  firstForwarded,
  heldAnswer,
  passThrough,
  serve,
  socketAddress,
  startingAnswer,
  type PassOptions,
  type Target,
} from '../src/net/proxy.js';

const MiB = 1024 * 1024;
const STARTING_JSON = '{"error":{"code":"unavailable","message":"Hornhoof is starting.","reason":"starting"}}';
const STARTING_TEXT = 'Hornhoof is starting. Try again in a few seconds.
';
const UPGRADE =
  'GET /socket HTTP/1.1\r\nHost: hornhoof.test\r\nConnection: Upgrade\r\nUpgrade: x-test\r\nX-Stays: kept\r\n\r\n';
const EARLY_LIMIT = 64 * 1024;
const SWITCHED = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x-test\r\nConnection: Upgrade\r\n\r\n';

/* A promise to settle from outside, since Promise.withResolvers is newer than the language level the tests compile to. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

/* A server on a free port, taken down with every socket it has, upgraded ones too, when the test ends. */
async function listening(server: http.Server): Promise<Target> {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

const answering = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown) =>
  listening(http.createServer((req, res) => void handler(req, res)));

function through(target: Target, options: Partial<PassOptions> = {}): Promise<Target> {
  return listening(serve(passThrough({ target, headers: () => ({}), unreachable: startingAnswer, ...options })));
}

async function servedThrough(target: Target, options: Partial<PassOptions> = {}): Promise<{ server: http.Server; proxy: Target }> {
  const server = serve(passThrough({ target, headers: () => ({}), unreachable: startingAnswer, ...options }));
  return { server, proxy: await listening(server) };
}

async function holdsNoSocket(server: http.Server): Promise<void> {
  await vi.waitFor(async () => {
    const count = await new Promise((resolve, reject) =>
      server.getConnections((error, connections) => (error ? reject(error) : resolve(connections))),
    );
    expect(count).toBe(0);
  });
}

/* A port nothing listens on. */
async function downTarget(): Promise<Target> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return { host: '127.0.0.1', port };
}

type Answer = { status: number; message: string; headers: http.IncomingHttpHeaders; raw: string[]; body: string };

function send(to: Target, options: http.RequestOptions = {}, body?: Buffer | string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = http.request({ ...to, agent: false, ...options }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          message: res.statusMessage ?? '',
          headers: res.headers,
          raw: res.rawHeaders,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    out.on('error', reject);
    out.end(body);
  });
}

async function bodyOf(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; raw: string[]; body: string };

/* A target that answers 200 once it has the whole body, and keeps what it was sent. */
async function recording(): Promise<{ target: Target; seen: Seen[] }> {
  const seen: Seen[] = [];
  const target = await answering(async (req, res) => {
    const body = await bodyOf(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, raw: req.rawHeaders, body });
    res.end('ok');
  });
  return { target, seen };
}

async function connected(to: Target): Promise<net.Socket> {
  const socket = net.connect(to.port, to.host);
  socket.on('error', () => {});
  onTestFinished(() => void socket.destroy());
  await once(socket, 'connect');
  return socket;
}

/* All a raw client reads until its socket is closed. */
async function readToEnd(socket: Duplex, encoding: BufferEncoding = 'utf8'): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(chunk);
  return Buffer.concat(chunks).toString(encoding);
}

async function exchange(to: Target, text: string, encoding?: BufferEncoding): Promise<string> {
  const socket = await connected(to);
  socket.write(text);
  return readToEnd(socket, encoding);
}

/* Reads until the socket has said the words, and leaves it open. */
function readsUntil(socket: Duplex, wanted: string, encoding: BufferEncoding = 'utf8'): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const closed = () => reject(new Error(`The socket closed before it said ${wanted}.`));
    const read = (chunk: Buffer) => {
      text += chunk.toString(encoding);
      if (!text.includes(wanted)) return;
      socket.off('data', read);
      socket.off('close', closed);
      resolve(text);
    };
    socket.on('data', read);
    socket.once('close', closed);
  });
}

const namesIn = (raw: string[]) => raw.filter((_, index) => index % 2 === 0).map(name => name.toLowerCase());

/* Writes the same chunk again and again, as fast as the other side takes it, and counts what it took. */
async function pour(out: Writable, chunk: Buffer, times: number, poured: { bytes: number }): Promise<void> {
  for (let i = 0; i < times; i++) {
    poured.bytes += chunk.length;
    if (!out.write(chunk)) await once(out, 'drain');
  }
  out.end();
}

function closesWithin(ms: number, emitter: NodeJS.EventEmitter): Promise<unknown> {
  return once(emitter, 'close', { signal: AbortSignal.timeout(ms) });
}

function withLookupThatNeverAnswers(): void {
  const lookup = vi.spyOn(dns, 'lookup').mockImplementation((() => {}) as unknown as typeof dns.lookup);
  onTestFinished(() => lookup.mockRestore());
}

function failOnUncaught(): void {
  const caught: unknown[] = [];
  const onCaught = (error: unknown) => caught.push(error);
  process.on('uncaughtException', onCaught);
  process.on('unhandledRejection', onCaught);
  onTestFinished(() => {
    process.off('uncaughtException', onCaught);
    process.off('unhandledRejection', onCaught);
    expect(caught).toEqual([]);
  });
}

/* The proxy's timers and the clocks it reads, moved only by the test. Sockets and Node's own timers stay real. */
function onTestClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  onTestFinished(() => void vi.useRealTimers());
}

/* Longer than any limit of the proxy's own, so that this stretch on the test clock runs out whatever such a limit times. */
const QUIET_MS = 10 * 60_000;

/* The idle limits put on any socket from now on. Node counts them on a clock of its own, which no test moves. */
function idleLimits(): () => number[] {
  const set = vi.spyOn(net.Socket.prototype, 'setTimeout');
  onTestFinished(() => void set.mockRestore());
  return () => set.mock.calls.map(([ms]) => ms).filter(ms => ms > 0);
}

/* Counts the writes into an HTTP message that had no room left for them: a side that holds back while the other end does
   not read makes none. */
function writesWithNoRoom(): () => number {
  const write = http.OutgoingMessage.prototype.write;
  let count = 0;
  const spy = vi.spyOn(http.OutgoingMessage.prototype, 'write').mockImplementation(function (
    this: http.OutgoingMessage,
    ...args: Parameters<typeof write>
  ) {
    if (this.writableNeedDrain) count++;
    return write.apply(this, args);
  });
  onTestFinished(() => void spy.mockRestore());
  return () => count;
}

/* The limit on a connect to the target is the proxy's one timer here. */
const untilConnectLimited = () => eventually(() => vi.getTimerCount() === 1);

describe('requests', () => {
  it('passes a request, its body and its answer', async () => {
    const sent = randomBytes(MiB);
    let arrived = '';
    const target = await answering((req, res) => {
      const hash = createHash('sha256');
      req.on('data', chunk => hash.update(chunk));
      req.on('end', () => {
        arrived = hash.digest('hex');
        res.writeHead(201, { 'x-own': 'kept' });
        res.end('made');
      });
    });
    const answer = await send(await through(target), { method: 'POST', path: '/upload?x=1' }, sent);
    expect(arrived).toBe(createHash('sha256').update(sent).digest('hex'));
    expect(answer).toMatchObject({ status: 201, body: 'made' });
    expect(answer.headers['x-own']).toBe('kept');
  });

  it('sends the method and the path as they came', async () => {
    const { target, seen } = await recording();
    await send(await through(target), { method: 'PATCH', path: '/api/x?y=1&z=%20' }, 'a');
    expect(seen[0]).toMatchObject({ method: 'PATCH', url: '/api/x?y=1&z=%20', body: 'a' });
  });

  it('gives back the status text, the header names and every cookie as they were', async () => {
    const target = await answering((_, res) => {
      res.writeHead(201, 'Made Up', ['X-Own-Header', 'kept', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2']);
      res.end();
    });
    const answer = await send(await through(target));
    expect(answer.message).toBe('Made Up');
    expect(answer.raw.slice(0, 6)).toEqual(['X-Own-Header', 'kept', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2']);
  });

  it('streams an answer as it comes', async () => {
    let secondWritten = false;
    const target = await answering(async (_, res) => {
      res.write('data: 1\n\n');
      await sleep(300);
      secondWritten = true;
      res.end('data: 2\n\n');
    });
    const out = http.request({ ...(await through(target)), agent: false });
    out.end();
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    const [first] = (await once(res, 'data')) as [Buffer];
    expect(first.toString()).toBe('data: 1\n\n');
    expect(secondWritten).toBe(false);
    expect(await bodyOf(res)).toBe('data: 2\n\n');
  });

  it('gives the head of an answer before its first chunk', async () => {
    let chunkWritten = false;
    const target = await answering(async (_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      await sleep(300);
      chunkWritten = true;
      res.end('data: 1\n\n');
    });
    const out = http.request({ ...(await through(target)), agent: false });
    out.end();
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    expect(chunkWritten).toBe(false);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(await bodyOf(res)).toBe('data: 1\n\n');
  });

  it('keeps a quiet stream open', async () => {
    const quiet = deferred();
    const target = await answering(async (_, res) => {
      res.write('data: 1\n\n');
      await quiet.promise;
      res.end('data: 2\n\n');
    });
    const proxy = await through(target);
    onTestClock();
    const idle = idleLimits();
    const out = http.request({ ...proxy, agent: false });
    out.end();
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    let body = '';
    res.on('data', chunk => (body += chunk));
    await eventually(() => body !== '');

    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(idle()).toEqual([]);
    quiet.resolve();
    await once(res, 'end');
    expect(body).toBe('data: 1\n\ndata: 2\n\n');
  });

  it('passes a request that expects a 100 Continue', async () => {
    const { target, seen } = await recording();
    const out = http.request({
      ...(await through(target)),
      agent: false,
      method: 'POST',
      headers: { expect: '100-continue', 'content-length': '4' },
    });
    out.flushHeaders();
    await once(out, 'continue');
    out.end('body');
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    expect(res.statusCode).toBe(200);
    expect(seen[0].body).toBe('body');
  });

  it.each([
    ['HEAD', 200],
    ['GET', 204],
    ['GET', 304],
  ])('passes a %s answered %i, which has no body', async (method, status) => {
    const target = await answering((_, res) => {
      res.writeHead(status, { etag: '"v1"' });
      res.end();
    });
    const answer = await send(await through(target), { method });
    expect(answer).toMatchObject({ status, body: '' });
    expect(answer.headers.etag).toBe('"v1"');
  });

  it('gives a HEAD the length of what a GET would get', async () => {
    const target = await answering((_, res) => {
      res.writeHead(200, { 'content-length': '5' });
      res.end();
    });
    const answer = await send(await through(target), { method: 'HEAD' });
    expect(answer.headers['content-length']).toBe('5');
  });

  it('opens a connection of its own for each request', async () => {
    let connections = 0;
    const server = http.createServer((_, res) => res.end('ok'));
    server.on('connection', () => connections++);
    const proxy = await through(await listening(server));
    await send(proxy);
    await send(proxy);
    expect(connections).toBe(2);
  });

  it('keeps a client connection through an idle stretch that would end it at 5 s', async () => {
    const { server, proxy } = await servedThrough(await answering((_, res) => res.end('ok')));
    /* Node ends an idle connection on a clock of its own, which no test moves. The proxy's part is the time it gives that
       clock: what clients have today, where Node's own would be 5 s. */
    expect(server.keepAliveTimeout).toBe(72_000);
    const socket = await connected(proxy);
    socket.write('GET /first HTTP/1.1\r\nHost: h\r\n\r\n');
    await readsUntil(socket, 'ok');
    socket.write('GET /second HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n');
    expect((await readToEnd(socket)).split('\r\n')[0]).toBe('HTTP/1.1 200 OK');
  });

  it('takes no request on a connection the target closed while idle', async () => {
    const server = http.createServer((_, res) => res.end('ok'));
    const proxy = await through(await listening(server));
    expect((await send(proxy)).status).toBe(200);
    /* What the target's keep-alive limit does to its idle connections once it runs out, done at once. */
    server.closeIdleConnections();
    expect((await send(proxy)).status).toBe(200);
  });
});

describe('neither dropped nor doubled', () => {
  it('carries many requests at once, each exactly once, each to its own client', async () => {
    const seen: string[] = [];
    const echo = await answering(async (req, res) => {
      const body = await bodyOf(req);
      seen.push(body);
      res.end(body);
    });
    const proxy = await through(echo);
    const ids = Array.from({ length: 100 }, (_, index) => `request-${index}`);
    const answers = await Promise.all(ids.map(id => send(proxy, { method: 'POST', path: `/${id}` }, id)));
    expect(answers.map(answer => answer.body)).toEqual(ids);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('answers pipelined requests in order, each once', async () => {
    let hits = 0;
    const target = await answering(async (req, res) => {
      hits++;
      if (req.url === '/slow') await sleep(200);
      res.end(req.url);
    });
    const proxy = await through(target);
    const text = await exchange(
      proxy,
      'GET /slow HTTP/1.1\r\nHost: h\r\n\r\nGET /fast HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n',
    );
    expect(text.indexOf('/slow')).toBeGreaterThan(-1);
    expect(text.indexOf('/slow')).toBeLessThan(text.indexOf('/fast'));
    expect(hits).toBe(2);
  });

  it.each(['GET', 'POST'])('never sends a %s again when the target fails it', async method => {
    let hits = 0;
    const target = await answering(req => {
      hits++;
      req.socket.destroy();
    });
    const answer = await send(await through(target), { method, path: '/api/x' }, method === 'POST' ? 'body' : undefined);
    expect(answer.status).toBe(502);
    await sleep(300);
    expect(hits).toBe(1);
  });

  it('answers 502 to an upload the target resets partway, and takes the rest of it', async () => {
    const target = await answering(req => {
      req.once('data', () => req.socket.resetAndDestroy());
    });
    const answer = await send(await through(target), { method: 'POST', path: '/api/x' }, randomBytes(4 * MiB));
    expect(answer.status).toBe(502);
    expect(answer.body).toBe(STARTING_JSON);
  });

  it('gives a client an answer that comes before its upload ends, and takes the rest of it', async () => {
    const target = await answering((_, res) => {
      res.writeHead(413, { 'content-type': 'text/plain' });
      res.end('too large');
    });
    const socket = await connected(await through(target));
    socket.write(`POST /upload HTTP/1.1\r\nHost: h\r\nContent-Length: ${1 + 32 * MiB}\r\n\r\nx`);
    const first = await readsUntil(socket, 'too large');
    expect(first.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large');
    for (let i = 0; i < 32; i++) {
      if (!socket.write(Buffer.alloc(MiB))) await once(socket, 'drain');
    }
    socket.write('GET /next HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n');
    const second = await readToEnd(socket);
    expect(second.split('\r\n')[0]).toBe('HTTP/1.1 413 Payload Too Large');
    expect(second).toContain('too large');
  });

  it.each([
    ['closes', (socket: net.Socket) => void socket.destroy()],
    ['resets', (socket: net.Socket) => void socket.resetAndDestroy()],
  ])('cuts the answer when the target %s halfway, and never ends it cleanly', async (_, die) => {
    const target = await answering(async (req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('part');
      await sleep(100);
      die(req.socket);
    });
    await expect(send(await through(target))).rejects.toThrow('aborted');
  });

  it('cuts a chunked answer as well when the target dies halfway', async () => {
    const target = await answering(async (req, res) => {
      res.write('part');
      await sleep(100);
      req.socket.destroy();
    });
    await expect(send(await through(target))).rejects.toThrow('aborted');
  });

  it.each([
    ['a length', 'POST /upload HTTP/1.1\r\nHost: h\r\nContent-Length: 1000\r\n\r\nonly a part'],
    ['chunks', 'POST /upload HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n4\r\npart\r\n'],
  ])('never gives the target a whole request when an upload framed by %s is cut', async (_, upload) => {
    let complete: boolean | null = null;
    const closed = deferred<void>();
    const target = await answering(req => {
      req.resume();
      req.once('close', () => {
        complete = req.complete;
        closed.resolve();
      });
    });
    const socket = await connected(await through(target));
    socket.write(upload);
    await sleep(100);
    socket.destroy();
    await closed.promise;
    expect(complete).toBe(false);
  });

  it('closes the request at the target when the client leaves before the answer', async () => {
    const arrived = deferred<http.ServerResponse>();
    const target = await answering((_, res) => arrived.resolve(res));
    failOnUncaught();
    const socket = await connected(await through(target));
    socket.write('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    const atTarget = await arrived.promise;
    socket.destroy();
    await closesWithin(1000, atTarget);
    await sleep(50);
  });

  it('does not ask for an answer to a client that left before the target answered', async () => {
    const arrived = deferred();
    let asked = 0;
    const target = await answering(() => arrived.resolve());
    const proxy = await through(target, {
      unreachable: req => {
        asked++;
        return startingAnswer(req);
      },
    });
    const socket = await connected(proxy);
    socket.write('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    await arrived.promise;
    socket.destroy();
    await sleep(200);
    expect(asked).toBe(0);
  });

  it('closes the answer at the target when the client leaves during it', async () => {
    const arrived = deferred<http.ServerResponse>();
    const target = await answering((_, res) => {
      res.write('first');
      arrived.resolve(res);
    });
    const socket = await connected(await through(target));
    socket.write('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    const atTarget = await arrived.promise;
    await readsUntil(socket, 'first');
    socket.destroy();
    await closesWithin(1000, atTarget);
  });

  it('holds an upload back while the target does not read it', async () => {
    const hash = createHash('sha256');
    const reading = deferred<void>();
    const finished = deferred<string>();
    const target = await answering(async (req, res) => {
      await reading.promise;
      for await (const chunk of req) hash.update(chunk);
      finished.resolve(hash.digest('hex'));
      res.end('ok');
    });
    const chunk = randomBytes(MiB);
    const times = 128;
    const { server, proxy } = await servedThrough(target);
    let passing: http.IncomingMessage | undefined;
    server.on('request', req => (passing = req));
    const noRoom = writesWithNoRoom();
    const out = http.request({
      ...proxy,
      agent: false,
      method: 'POST',
      headers: { 'content-length': String(times * MiB) },
    });
    const poured = { bytes: 0 };
    void pour(out, chunk, times, poured);
    /* The proxy stops reading the upload once the target's side of it is full, or else writes into it with no room. */
    await eventually(() => passing?.isPaused() === true || noRoom() > 0);
    expect(poured.bytes).toBeLessThan(times * MiB);
    reading.resolve();
    const sent = createHash('sha256');
    for (let i = 0; i < times; i++) sent.update(chunk);
    expect(await finished.promise).toBe(sent.digest('hex'));
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    expect(res.statusCode).toBe(200);
    expect(noRoom()).toBe(0);
  });

  it('holds an answer back while the client does not read it', async () => {
    const times = 128;
    const poured = { bytes: 0 };
    const target = await answering((_, res) => void pour(res, Buffer.alloc(MiB), times, poured));
    const { server, proxy } = await servedThrough(target);
    let toClient: http.ServerResponse | undefined;
    server.on('request', (_, res) => (toClient = res));
    const noRoom = writesWithNoRoom();
    const out = http.request({ ...proxy, agent: false });
    out.end();
    const [res] = (await once(out, 'response')) as [http.IncomingMessage];
    res.pause();
    /* The client's side of the answer is full. */
    await eventually(() => toClient?.writableNeedDrain === true);
    expect(poured.bytes).toBeLessThan(times * MiB);
    let arrived = 0;
    res.on('data', chunk => (arrived += chunk.length));
    res.resume();
    await once(res, 'end');
    expect(arrived).toBe(times * MiB);
    expect(noRoom()).toBe(0);
  });

  it.each([
    ['something that is not HTTP', 'this is not http\r\n\r\n'],
    ['a status no server may write', 'HTTP/1.1 000 Nothing\r\nContent-Length: 0\r\n\r\n'],
  ])('outlives a target that answers %s', async (_, answer) => {
    const odd = net.createServer(socket => {
      socket.on('error', () => {});
      socket.end(answer);
    });
    await new Promise<void>(resolve => odd.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => void odd.close());
    failOnUncaught();
    const proxy = await through({ host: '127.0.0.1', port: (odd.address() as AddressInfo).port });
    expect((await send(proxy)).status).toBe(502);
  });

  it('lets go of a target whose answer it cannot write', async () => {
    const arrived = deferred<net.Socket>();
    const odd = net.createServer(socket => {
      socket.on('error', () => {});
      socket.resume();
      socket.write('HTTP/1.1 000 Nothing\r\nContent-Length: 100\r\n\r\n');
      arrived.resolve(socket);
    });
    await new Promise<void>(resolve => odd.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => void odd.close());
    const proxy = await through({ host: '127.0.0.1', port: (odd.address() as AddressInfo).port });
    expect((await send(proxy)).status).toBe(502);
    await closesWithin(1000, await arrived.promise);
  });
});

describe('headers', () => {
  it('passes the stamp and the signature of a signed delivery receipt, which only their own check believes', async () => {
    const { target, seen } = await recording();
    const proxy = await through(target);
    await send(proxy, { headers: { 'x-hornhoof-timestamp': '1794300000', 'x-hornhoof-signature': 'abc', 'x-hornhoof-internal': 'forged', 'x-hornhoof-recovery': 'a-proof' } });
    const { headers } = seen[0];
    expect(headers['x-hornhoof-timestamp']).toBe('1794300000');
    expect(headers['x-hornhoof-signature']).toBe('abc');
    /* The proof a machine that survived sends with a bundle is made outside too, and only its check believes it. */
    expect(headers['x-hornhoof-recovery']).toBe('a-proof');
    expect(headers['x-hornhoof-internal']).toBeUndefined();
  });

  it('drops forwarding headers that came in and adds its own', async () => {
    const { target, seen } = await recording();
    const proxy = await through(target, {
      headers: () => ({ 'x-forwarded-for': '203.0.113.9', 'x-hornhoof-via': 'this hop' }),
    });
    await send(proxy, {
      headers: {
        'x-forwarded-for': '198.51.100.7',
        'x-forwarded-proto': 'https',
        'x-hornhoof-via': 'x',
        'x-hornhoof-other': 'x',
        host: 'corp.hornhoof.test',
        'x-forwarded-host': 'corp.hornhoof.test',
        'x-other': 'kept',
      },
    });
    const { headers } = seen[0];
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(headers['x-hornhoof-via']).toBe('this hop');
    expect(headers['x-forwarded-proto']).toBeUndefined();
    expect(headers['x-hornhoof-other']).toBeUndefined();
    expect(headers.host).toBe('corp.hornhoof.test');
    expect(headers['x-forwarded-host']).toBe('corp.hornhoof.test');
    expect(headers['x-other']).toBe('kept');
  });

  it('adds what headers() gave for the proto as well, and only that', async () => {
    const { target, seen } = await recording();
    const proxy = await through(target, { headers: () => ({ 'x-forwarded-proto': 'https' }) });
    await send(proxy, { headers: { 'x-forwarded-proto': 'http', 'x-forwarded-for': '198.51.100.7' } });
    expect(seen[0].headers['x-forwarded-proto']).toBe('https');
    expect(seen[0].headers['x-forwarded-for']).toBeUndefined();
  });

  it('drops every copy of a forged header, whatever its case', async () => {
    const { target, seen } = await recording();
    const proxy = await through(target, { headers: () => ({ 'x-forwarded-for': '203.0.113.9' }) });
    await exchange(
      proxy,
      'GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\nX-Forwarded-For: 198.51.100.7\r\nx-FORWARDED-for: 198.51.100.8\r\nX-Hornhoof-Via: a\r\nX-HORNHOOF-VIA: b\r\n\r\n',
    );
    const names = namesIn(seen[0].raw);
    expect(names.filter(name => name === 'x-forwarded-for')).toHaveLength(1);
    expect(seen[0].headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(names).not.toContain('x-hornhoof-via');
  });

  it('drops the hop-by-hop headers and the names Connection lists', async () => {
    const { target, seen } = await recording();
    await exchange(
      await through(target),
      [
        'GET / HTTP/1.1',
        'Host: h',
        'Connection: close, X-Hop-One, x-hop-two',
        'X-Hop-One: a',
        'X-Hop-Two: a',
        'Keep-Alive: timeout=9',
        'Proxy-Connection: keep-alive',
        'TE: trailers',
        'Trailer: X-Trail',
        'Upgrade: h2c',
        'X-Stays: kept',
        '',
        '',
      ].join('\r\n'),
    );
    const names = namesIn(seen[0].raw);
    for (const dropped of ['x-hop-one', 'x-hop-two', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']) {
      expect(names).not.toContain(dropped);
    }
    expect(seen[0].headers['x-stays']).toBe('kept');
  });

  it('keeps a header Connection does not list', async () => {
    const { target, seen } = await recording();
    await exchange(await through(target), 'GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\nX-Hop: a\r\nCookie: b=1\r\n\r\n');
    expect(seen[0].headers['x-hop']).toBe('a');
    expect(seen[0].headers.cookie).toBe('b=1');
  });

  it('carries a chunked body on a method with no body by default, and smuggles nothing', async () => {
    const { target, seen } = await recording();
    const hidden = 'GET /hidden HTTP/1.1\r\nHost: h\r\nX-Forwarded-For: 198.51.100.7\r\n\r\n';
    await exchange(
      await through(target),
      `DELETE /seen HTTP/1.1\r\nHost: h\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n${hidden.length.toString(16)}\r\n${hidden}\r\n0\r\n\r\n`,
    );
    await sleep(100);
    expect(seen.map(one => [one.method, one.url, one.body])).toEqual([['DELETE', '/seen', hidden]]);
    expect(seen[0].headers['transfer-encoding']).toBe('chunked');
  });

  it('keeps the length of a body when Connection lists it, and smuggles nothing', async () => {
    const { target, seen } = await recording();
    const hidden = 'GET /hidden HTTP/1.1\r\nHost: h\r\nX-Forwarded-For: 198.51.100.7\r\n\r\n';
    await exchange(
      await through(target),
      `GET /seen HTTP/1.1\r\nHost: h\r\nConnection: close, content-length\r\nContent-Length: ${hidden.length}\r\n\r\n${hidden}`,
    );
    await sleep(100);
    expect(seen.map(one => [one.url, one.body])).toEqual([['/seen', hidden]]);
    expect(seen[0].headers['content-length']).toBe(String(hidden.length));
  });

  it('keeps a chunked body framed when Connection lists transfer-encoding', async () => {
    const { target, seen } = await recording();
    await exchange(
      await through(target),
      'OPTIONS /seen HTTP/1.1\r\nHost: h\r\nConnection: close, transfer-encoding\r\nTransfer-Encoding: chunked\r\n\r\n4\r\npart\r\n0\r\n\r\n',
    );
    await sleep(100);
    expect(seen.map(one => [one.url, one.body])).toEqual([['/seen', 'part']]);
  });

  it('sends an empty POST without a chunked body, which some routes refuse', async () => {
    const { target, seen } = await recording();
    await exchange(await through(target), 'POST /x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n');
    expect(seen[0].headers['transfer-encoding']).toBeUndefined();
    expect(seen[0].body).toBe('');
  });

  it('sends a GET with no framing at all', async () => {
    const { target, seen } = await recording();
    await exchange(await through(target), 'GET /x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n');
    expect(seen[0].headers['transfer-encoding']).toBeUndefined();
    expect(seen[0].headers['content-length']).toBeUndefined();
  });

  it('keeps the hop-by-hop headers of an answer from the client', async () => {
    let connections = 0;
    const server = serve(passThrough({
      target: await answering((_, res) => {
        res.setHeader('Connection', 'close, X-Hop');
        res.setHeader('X-Hop', 'a');
        res.setHeader('Keep-Alive', 'timeout=1');
        res.setHeader('Proxy-Connection', 'x');
        res.setHeader('Upgrade', 'h2c');
        res.setHeader('Trailer', 'x-trail');
        res.setHeader('X-Stays', 'kept');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.end('whole');
      }),
      headers: () => ({}),
      unreachable: startingAnswer,
    }));
    server.on('connection', () => connections++);
    const proxy = await listening(server);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    onTestFinished(() => agent.destroy());
    const first = await send(proxy, { agent });
    const second = await send(proxy, { agent });
    expect([first.body, second.body]).toEqual(['whole', 'whole']);
    expect(first.headers['x-stays']).toBe('kept');
    expect(first.headers.connection).toBe('keep-alive');
    const names = namesIn(first.raw);
    for (const dropped of ['x-hop', 'proxy-connection', 'upgrade', 'trailer']) expect(names).not.toContain(dropped);
    expect(first.headers['keep-alive']).toBe('timeout=72');
    expect(connections).toBe(1);
  });

  it('waits for headers() without losing a byte of the body', async () => {
    const { target, seen } = await recording();
    const proxy = await through(target, {
      headers: async () => {
        await sleep(100);
        return { 'x-forwarded-for': '203.0.113.9' };
      },
    });
    const body = randomBytes(MiB).toString('hex');
    await send(proxy, { method: 'POST' }, body);
    expect(seen[0].body).toBe(body);
    expect(seen[0].headers['x-forwarded-for']).toBe('203.0.113.9');
  });

  it.each([
    ['throws', () => { throw new Error('no'); }],
    ['rejects', async () => { throw new Error('no'); }],
  ])('answers as for a target that is down when headers() %s', async (_, headers) => {
    const { target, seen } = await recording();
    failOnUncaught();
    const proxy = await through(target, { headers });
    const answer = await send(proxy, { path: '/api/x' });
    expect(answer.status).toBe(502);
    await expect(new Promise((_, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/`);
      socket.on('error', reject);
    })).rejects.toThrow('Unexpected server response: 502');
    expect(seen).toEqual([]);
  });

  it('closes the connection when headers() fails on a request with a body, which nothing read', async () => {
    const { target, seen } = await recording();
    failOnUncaught();
    const proxy = await through(target, { headers: () => Promise.reject(new Error('no')) });
    const socket = await connected(proxy);
    const closed = closesWithin(1000, socket);
    const text = readToEnd(socket);
    socket.write('POST /api/x HTTP/1.1\r\nHost: h\r\nContent-Length: 1000\r\n\r\nonly a part');
    await closed;
    const [head] = (await text).split('\r\n\r\n');
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    expect(head.toLowerCase()).toContain('connection: close');
    expect(seen).toEqual([]);
  });

  it('outlives headers() failing for a client that has already left', async () => {
    failOnUncaught();
    const asked = deferred();
    const proxy = await through(await answering((_, res) => res.end('ok')), {
      headers: async () => {
        asked.resolve();
        await sleep(100);
        throw new Error('no');
      },
    });
    const socket = await connected(proxy);
    socket.write('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    await asked.promise;
    socket.destroy();
    await sleep(200);
  });

  it('sends nothing for a client that left while headers() waited', async () => {
    const { target, seen } = await recording();
    failOnUncaught();
    const asked = deferred<void>();
    const proxy = await through(target, {
      headers: async () => {
        asked.resolve();
        await sleep(200);
        return {};
      },
    });
    const socket = await connected(proxy);
    socket.write('GET / HTTP/1.1\r\nHost: h\r\n\r\n');
    await asked.promise;
    socket.destroy();
    await sleep(400);
    expect(seen).toEqual([]);
  });

  it('answers as for a target that is down when the request cannot be sent on', async () => {
    const { target, seen } = await recording();
    failOnUncaught();
    const proxy = await through(target, { headers: () => ({ 'x-bad': 'line\nbreak' }) });
    expect((await send(proxy)).status).toBe(502);
    expect(seen).toEqual([]);
  });
});

describe('a target that is down', () => {
  it('answers for a target that is down', async () => {
    const proxy = await through(await downTarget());

    const api = await send(proxy, { path: '/api/x' });
    expect(api.status).toBe(502);
    expect(api.headers['retry-after']).toBe('5');
    expect(api.headers['content-type']).toBe('application/json');
    expect(api.headers['content-length']).toBe(String(Buffer.byteLength(STARTING_JSON)));
    expect(api.body).toBe(STARTING_JSON);

    const page = await send(proxy, { path: '/' });
    expect(page.status).toBe(502);
    expect(page.headers['retry-after']).toBe('5');
    expect(page.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(page.headers['content-length']).toBe(String(Buffer.byteLength(STARTING_TEXT)));
    expect(page.body).toBe(STARTING_TEXT);

    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/`);
    await expect(once(socket, 'open')).rejects.toThrow('Unexpected server response: 502');
  });

  it('writes the same status line and body on an upgrade, then ends the socket', async () => {
    const proxy = await through(await downTarget());
    const text = await exchange(proxy, UPGRADE);
    expect(text.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
    const [head, body] = text.split('\r\n\r\n');
    expect(head.toLowerCase()).toContain('retry-after: 5');
    expect(head.toLowerCase()).toContain('content-type: text/plain; charset=utf-8');
    expect(head.toLowerCase()).toContain(`content-length: ${Buffer.byteLength(STARTING_TEXT)}`);
    expect(head.toLowerCase()).toContain('connection: close');
    expect(body).toBe(STARTING_TEXT);
  });

  it('asks its own unreachable for the answer', async () => {
    const proxy = await through(await downTarget(), {
      unreachable: req => ({ status: 503, headers: { 'x-url': String(req.url) }, body: 'мимо' }),
    });
    const answer = await send(proxy, { path: '/own' });
    expect(answer).toMatchObject({ status: 503, body: 'мимо' });
    expect(answer.headers['x-url']).toBe('/own');
    const upgraded = await exchange(proxy, UPGRADE);
    expect(upgraded.split('\r\n')[0]).toBe('HTTP/1.1 503 Service Unavailable');
    expect(upgraded.toLowerCase()).toContain('x-url: /socket');
    expect(upgraded.split('\r\n\r\n')[1]).toBe('мимо');
  });

  it('gives up on a target that does not connect within connectMs', async () => {
    const proxy = await through({ host: 'never.hornhoof.test', port: 7080 }, { connectMs: 200 });
    withLookupThatNeverAnswers();
    onTestClock();
    const answer = send(proxy, { path: '/api/x' });
    await untilConnectLimited();
    await vi.advanceTimersByTimeAsync(199);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await answer).body).toBe(STARTING_JSON);
    const upgraded = exchange(proxy, UPGRADE);
    await untilConnectLimited();
    await vi.advanceTimersByTimeAsync(200);
    expect((await upgraded).split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
  });

  it('gives a connect 5 seconds unless told otherwise', async () => {
    const proxy = await through({ host: 'never.hornhoof.test', port: 7080 });
    withLookupThatNeverAnswers();
    onTestClock();
    const answer = send(proxy);
    await untilConnectLimited();
    await vi.advanceTimersByTimeAsync(4999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await answer).status).toBe(502);
  });

  it('takes a connectMs of 0 at its word', async () => {
    const proxy = await through({ host: 'never.hornhoof.test', port: 7080 }, { connectMs: 0 });
    withLookupThatNeverAnswers();
    onTestClock();
    const answer = send(proxy);
    await untilConnectLimited();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await answer).status).toBe(502);
  });

  it('leaves no timer behind a connect that failed, so a stopping process can end', async () => {
    const script = `
      import http from 'node:http';
      import { passThrough, serve, startingAnswer } from './src/net/proxy.ts';
      const server = serve(passThrough({
        target: { host: '127.0.0.1', port: 1 }, headers: () => ({}), unreachable: startingAnswer, connectMs: 60000,
      }));
      server.listen(0, '127.0.0.1', () => {
        http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, res => {
          res.resume();
          res.on('end', () => server.close());
        });
      });
    `;
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const args = ['--import', 'tsx', '--input-type=module', '-e', script];
    await promisify(execFile)(process.execPath, args, { cwd, timeout: 10_000 });
  });

  it('puts no limit on a target that connected and takes its time', async () => {
    const target = await answering(async (_, res) => {
      await sleep(400);
      res.end('late');
    });
    const answer = await send(await through(target, { connectMs: 100 }));
    expect(answer).toMatchObject({ status: 200, body: 'late' });
  });
});

describe('upgrades', () => {
  /* A target that takes an upgrade the way a real one does: it reads its socket, and closes it when the other end does. */
  function takingUpgrades(taken: (socket: Duplex, head: Buffer) => void): Promise<Target> {
    const server = http.createServer((_, res) => res.end('ok'));
    server.on('upgrade', (_, socket, head) => {
      socket.on('error', () => {});
      socket.on('end', () => socket.end());
      socket.resume();
      taken(socket, head);
    });
    return listening(server);
  }

  async function webSockets(options: Partial<PassOptions> = {}) {
    const server = http.createServer();
    const sockets = new WebSocketServer({ server });
    const proxy = await through(await listening(server), options);
    const open = async () => {
      const client = new WebSocket(`ws://127.0.0.1:${proxy.port}/socket`);
      client.on('error', () => {});
      onTestFinished(() => client.terminate());
      const arrived = once(sockets, 'connection') as Promise<[WebSocket, http.IncomingMessage]>;
      await once(client, 'open');
      const [atTarget, request] = await arrived;
      atTarget.on('error', () => {});
      return { client, atTarget, request };
    };
    return { proxy, open };
  }

  it('passes WebSockets both ways and closes them together', async () => {
    const { open } = await webSockets();
    const first = await open();
    const up = once(first.atTarget, 'message');
    first.client.send('up');
    expect(String((await up)[0])).toBe('up');
    const down = once(first.client, 'message');
    first.atTarget.send('down');
    expect(String((await down)[0])).toBe('down');
    const targetClosed = closesWithin(1000, first.atTarget);
    first.client.close();
    await targetClosed;

    const second = await open();
    const clientClosed = closesWithin(1000, second.client);
    second.atTarget.close();
    await clientClosed;
  });

  it.each([
    ['client', 'target'],
    ['target', 'client'],
  ] as const)('closes the %s when the %s is terminated', async (other, gone) => {
    const { open } = await webSockets();
    const { client, atTarget } = await open();
    const sides = { client, target: atTarget };
    const closed = closesWithin(1000, sides[other]);
    sides[gone].terminate();
    await closed;
  });

  it('keeps a quiet WebSocket open', async () => {
    const { open } = await webSockets();
    onTestClock();
    const idle = idleLimits();
    const { client, atTarget } = await open();
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(idle()).toEqual([]);
    const up = once(atTarget, 'message');
    client.send('still here');
    expect(String((await up)[0])).toBe('still here');
  });

  it('gives the target the upgrade with its own headers, and drops the forged ones', async () => {
    const { open } = await webSockets({ headers: () => ({ 'x-forwarded-for': '203.0.113.9' }) });
    const { request } = await open();
    expect(request.headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(request.url).toBe('/socket');
    expect(request.headers.upgrade).toBe('websocket');
    expect(request.headers.connection).toBe('Upgrade');
    expect(request.headers['sec-websocket-key']).toBeTruthy();

    const server = http.createServer();
    const seen = deferred<http.IncomingMessage>();
    server.on('upgrade', (req, socket) => {
      seen.resolve(req);
      socket.destroy();
    });
    const proxy = await through(await listening(server), { headers: () => ({ 'x-forwarded-for': '203.0.113.9' }) });
    const raw = await connected(proxy);
    raw.write(
      'GET /socket HTTP/1.1\r\nHost: corp.hornhoof.test\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nX-Forwarded-For: 198.51.100.7\r\nX-Forwarded-Proto: https\r\nX-Hornhoof-Via: x\r\nX-Forwarded-Host: corp.hornhoof.test\r\nX-Stays: kept\r\n\r\n',
    );
    const { headers, rawHeaders } = await seen.promise;
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(headers['x-forwarded-proto']).toBeUndefined();
    expect(headers['x-hornhoof-via']).toBeUndefined();
    expect(headers.host).toBe('corp.hornhoof.test');
    expect(headers['x-forwarded-host']).toBe('corp.hornhoof.test');
    expect(headers['x-stays']).toBe('kept');
    expect(headers.connection).toBe('Upgrade');
    expect(headers.upgrade).toBe('websocket');
    expect(namesIn(rawHeaders).filter(name => name === 'connection')).toHaveLength(1);
  });

  it('writes the 101 back as it came, with the bytes sent right behind it, both ways', async () => {
    let ahead = '';
    const asIs = 'HTTP/1.1 101 Switching It\r\nUpgrade: x-test\r\nConnection: Upgrade\r\nX-Own-Header: caf\xe9\r\n\r\n';
    const target = await takingUpgrades((socket, head) => {
      ahead += head.toString();
      socket.on('data', chunk => (ahead += chunk.toString()));
      socket.write(`${asIs}behind`, 'latin1');
    });
    const proxy = await through(target);
    const raw = await connected(proxy);
    raw.write(`${UPGRADE}ahead`);
    expect(await readsUntil(raw, 'behind', 'latin1')).toBe(`${asIs}behind`);
    raw.write('-more');
    await vi.waitFor(() => expect(ahead).toBe('ahead-more'));
  });

  it('writes back an answer other than 101, whole and unframed, and ends the socket', async () => {
    const target = await answering((_, res) => {
      res.writeHead(401, 'Who Are You', { 'x-own': 'caf\xe9' });
      res.write('a');
      res.end('b');
    });
    const text = await exchange(await through(target), UPGRADE, 'latin1');
    const [head, body] = text.split('\r\n\r\n');
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 401 Who Are You');
    expect(head.toLowerCase()).toContain('x-own: caf\xe9');
    expect(head.toLowerCase()).toContain('connection: close');
    expect(head.toLowerCase()).not.toContain('transfer-encoding');
    expect(body).toBe('ab');
  });

  it('gives a WebSocket the answer that refused it', async () => {
    const target = await answering((_, res) => {
      res.statusCode = 401;
      res.end('no');
    });
    const proxy = await through(target);
    const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/`);
    await expect(once(socket, 'open')).rejects.toThrow('Unexpected server response: 401');
  });

  it('closes the client when the answer that refused it is cut', async () => {
    const target = await answering(async (req, res) => {
      res.writeHead(401, { 'content-length': '100' });
      res.write('part');
      await sleep(100);
      req.socket.resetAndDestroy();
    });
    failOnUncaught();
    const socket = await connected(await through(target));
    socket.write(UPGRADE);
    await readsUntil(socket, 'part');
    await closesWithin(1000, socket);
  });

  it.each([
    ['answered a refusal', async () => (await answering((_, res) => res.end('no')))],
    ['could not reach the target', async () => ({ host: '127.0.0.1', port: 1 })],
  ])('keeps no socket once it %s, even for a client that keeps its half open', async (_, targetOf) => {
    const { server, proxy } = await servedThrough(await targetOf());
    const socket = net.connect({ ...proxy, allowHalfOpen: true });
    socket.on('error', () => {});
    onTestFinished(() => void socket.destroy());
    await once(socket, 'connect');
    socket.write(UPGRADE);
    socket.resume();
    await once(socket, 'end');
    await holdsNoSocket(server);
  });

  it('answers 502 when the target resets before it answers the upgrade', async () => {
    const target = await takingUpgrades(socket => (socket as net.Socket).resetAndDestroy());
    const text = await exchange(await through(target), UPGRADE);
    expect(text.split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
  });

  const LEAVING = [
    ['closes', (socket: net.Socket) => void socket.destroy()],
    ['resets', (socket: net.Socket) => void socket.resetAndDestroy()],
  ] as const;

  it.each(LEAVING)('closes the target when the client %s before the 101', async (_, leave) => {
    const arrived = deferred<Duplex>();
    const raw = await connected(await through(await takingUpgrades(socket => arrived.resolve(socket))));
    raw.write(UPGRADE);
    const atTarget = await arrived.promise;
    const closed = closesWithin(1000, atTarget);
    leave(raw);
    await closed;
  });

  it('carries what a client sent before the 101 to the target once it has answered, in order', async () => {
    const arrived = deferred<Duplex>();
    const raw = await connected(await through(await takingUpgrades(socket => arrived.resolve(socket))));
    raw.write(`${UPGRADE}ahead`);
    const atTarget = await arrived.promise;
    let received = '';
    atTarget.on('data', chunk => (received += chunk.toString()));
    raw.write('-early');
    await sleep(100);
    atTarget.write(SWITCHED);
    await readsUntil(raw, 'Upgrade');
    raw.write('-late');
    await vi.waitFor(() => expect(received).toBe('ahead-early-late'));
  });

  it.each(LEAVING)('keeps no socket when a client that sent bytes %s before the 101', async (_, leave) => {
    const arrived = deferred<Duplex>();
    const { server, proxy } = await servedThrough(await takingUpgrades(socket => arrived.resolve(socket)));
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    const atTarget = await arrived.promise;
    raw.write('early');
    await sleep(100);
    const closed = closesWithin(1000, atTarget);
    leave(raw);
    await closed;
    await holdsNoSocket(server);
  });

  it('carries exactly as much as it holds before the 101', async () => {
    const arrived = deferred<Duplex>();
    const raw = await connected(await through(await takingUpgrades(socket => arrived.resolve(socket))));
    raw.write(UPGRADE);
    const atTarget = await arrived.promise;
    let received = 0;
    atTarget.on('data', chunk => (received += chunk.length));
    raw.write(Buffer.alloc(EARLY_LIMIT, 'x'));
    await sleep(100);
    atTarget.write(SWITCHED);
    await readsUntil(raw, 'Upgrade');
    await vi.waitFor(() => expect(received).toBe(EARLY_LIMIT));
  });

  it('cuts a client that sends more than it holds before the 101, and the target with it', async () => {
    const arrived = deferred<Duplex>();
    const { server, proxy } = await servedThrough(await takingUpgrades(socket => arrived.resolve(socket)));
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    const atTarget = await arrived.promise;
    const closed = closesWithin(1000, atTarget);
    raw.resume();
    raw.write(Buffer.alloc(EARLY_LIMIT + 1, 'x'));
    await closed;
    await holdsNoSocket(server);
  });

  it('stops counting at the 101, so a live socket carries more than it holds before it and stays open', async () => {
    const arrived = deferred<Duplex>();
    const raw = await connected(await through(await takingUpgrades(socket => arrived.resolve(socket))));
    raw.write(UPGRADE);
    const atTarget = await arrived.promise;
    let received = 0;
    atTarget.on('data', chunk => (received += chunk.length));
    atTarget.write(SWITCHED);
    await readsUntil(raw, 'Upgrade');
    raw.write(Buffer.alloc(4 * EARLY_LIMIT, 'x'));
    await vi.waitFor(() => expect(received).toBe(4 * EARLY_LIMIT));
    raw.write('more');
    await vi.waitFor(() => expect(received).toBe(4 * EARLY_LIMIT + 4));
    atTarget.write('and back');
    await readsUntil(raw, 'and back');
    expect(raw.destroyed).toBe(false);
  });

  it('lets a client close its half after the 101 and still hear the last of the target', async () => {
    const server = http.createServer();
    server.on('upgrade', (_, socket) => {
      socket.on('error', () => {});
      socket.resume();
      socket.on('end', () => socket.end('last words'));
      socket.write(SWITCHED);
    });
    const proxy = await through(await listening(server));
    const raw = net.connect({ ...proxy, allowHalfOpen: true });
    raw.on('error', () => {});
    onTestFinished(() => void raw.destroy());
    await once(raw, 'connect');
    raw.write(UPGRADE);
    const said = readToEnd(raw);
    await sleep(100);
    raw.end();
    expect(await said).toBe(`${SWITCHED}last words`);
  });

  it('does not ask for an answer to a client that left before the 101', async () => {
    const arrived = deferred<Duplex>();
    let asked = 0;
    const proxy = await through(await takingUpgrades(socket => arrived.resolve(socket)), {
      unreachable: req => {
        asked++;
        return startingAnswer(req);
      },
    });
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    const atTarget = await arrived.promise;
    const closed = closesWithin(1000, atTarget);
    raw.destroy();
    await closed;
    await sleep(50);
    expect(asked).toBe(0);
  });

  it.each([
    ['closes', 'nothing', '', LEAVING[0][1]],
    ['resets', 'nothing', '', LEAVING[1][1]],
    ['closes', 'bytes', 'early', LEAVING[0][1]],
    ['resets', 'bytes', 'early', LEAVING[1][1]],
  ] as const)('keeps no socket and sends nothing on for a client that %s behind %s while headers() waits', async (_, __, bytes, leave) => {
    let hits = 0;
    const target = await takingUpgrades(socket => {
      hits++;
      socket.destroy();
    });
    const asked = deferred();
    failOnUncaught();
    const { server, proxy } = await servedThrough(target, {
      headers: async () => {
        asked.resolve();
        await sleep(200);
        return {};
      },
    });
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    await asked.promise;
    if (bytes) raw.write(bytes);
    await sleep(50);
    leave(raw);
    await sleep(400);
    expect(hits).toBe(0);
    await holdsNoSocket(server);
  });

  /* The state that loses bytes: the target has closed, its last bytes are still in this hop's memory, since the client's
     socket is full, and the client has not read them yet. So the target waits until this hop holds some of them back,
     and sends small pieces one at a time, or the hop would stop reading and not see the target close. */
  it('gives a client that reads late all the target sent before it closed', async () => {
    let atHop!: net.Socket;
    const sent = deferred<number>();
    const piece = Buffer.alloc(8192, 'x');
    const target = await takingUpgrades(socket => {
      const sendPieces = async () => {
        socket.write(SWITCHED);
        let bytes = Buffer.byteLength(SWITCHED);
        while (atHop.writableLength === 0) {
          const before = atHop.bytesWritten;
          socket.write(piece);
          bytes += piece.length;
          while (atHop.bytesWritten === before) await sleep(0);
        }
        socket.end(() => sent.resolve(bytes));
      };
      void sendPieces();
    });
    const server = serve(passThrough({ target, headers: () => ({}), unreachable: startingAnswer }));
    server.on('connection', socket => (atHop = socket));
    const raw = await connected(await listening(server));
    raw.write(UPGRADE);
    const bytes = await sent.promise;
    await sleep(200);
    expect((await readToEnd(raw, 'latin1')).length).toBe(bytes);
  });

  it('outlives a client that resets during an upgrade, before the 101', async () => {
    const arrived = deferred<void>();
    const target = await takingUpgrades(socket => {
      arrived.resolve();
      void sleep(200).then(() => socket.destroyed || socket.write(SWITCHED));
    });
    failOnUncaught();
    const proxy = await through(target);
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    await arrived.promise;
    raw.resetAndDestroy();
    await sleep(400);
    expect((await send(proxy)).status).toBe(200);
  });

  it('outlives a client that resets during an upgrade, right after the 101', async () => {
    const arrived = deferred<Duplex>();
    const target = await takingUpgrades(socket => {
      void sleep(200).then(() => {
        socket.write(SWITCHED);
        arrived.resolve(socket);
      });
    });
    failOnUncaught();
    const proxy = await through(target);
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    await readsUntil(raw, 'Upgrade');
    const atTarget = await arrived.promise;
    const closed = closesWithin(1000, atTarget);
    raw.resetAndDestroy();
    await closed;
    expect((await send(proxy)).status).toBe(200);
  });

  it('outlives a target that resets while a socket is open', async () => {
    const arrived = deferred<Duplex>();
    const target = await takingUpgrades(socket => {
      socket.write(SWITCHED);
      arrived.resolve(socket);
    });
    failOnUncaught();
    const proxy = await through(target);
    const raw = await connected(proxy);
    raw.write(UPGRADE);
    await readsUntil(raw, 'Upgrade');
    const closed = closesWithin(1000, raw);
    ((await arrived.promise) as net.Socket).resetAndDestroy();
    await closed;
    expect((await send(proxy)).status).toBe(200);
  });
});

describe('what a hop says about a request', () => {
  const asked = (fields: object) => fields as http.IncomingMessage;

  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:10.1.2.3', '10.1.2.3'],
    ['2001:db8::ffff:1', '2001:db8::ffff:1'],
    [undefined, ''],
  ])('names the socket %s as %j', (remoteAddress, name) => {
    expect(socketAddress(asked({ socket: { remoteAddress } }))).toBe(name);
  });

  it.each([
    [undefined, ''],
    ['', ''],
    ['198.51.100.7', '198.51.100.7'],
    ['  198.51.100.7 , 203.0.113.1', '198.51.100.7'],
    [', 203.0.113.1', ''],
  ])('takes %j to come from %j', (forwarded, first) => {
    expect(firstForwarded(asked({ headers: { 'x-forwarded-for': forwarded } }))).toBe(first);
  });

  it.each([
    ['/api/x', STARTING_JSON],
    ['/api/', STARTING_JSON],
    ['/mcp', STARTING_JSON],
    ['/mcp?x=1', STARTING_JSON],
    ['/mcp/x', STARTING_JSON],
    ['/', STARTING_TEXT],
    ['/api', STARTING_TEXT],
    ['/apix', STARTING_TEXT],
    ['/mcpx', STARTING_TEXT],
    ['/x/api/y', STARTING_TEXT],
    ['/x/mcp', STARTING_TEXT],
  ])('says it is starting to %s in the words that path reads', (url, body) => {
    const answer = startingAnswer(asked({ url }));
    expect(answer.status).toBe(502);
    expect(answer.headers['Retry-After']).toBe('5');
    expect(answer.body).toBe(body);
  });
});

describe('a request held while the target is down', () => {
  const HELD_JSON = '{"error":{"code":"unavailable","message":"Hornhoof did not answer for a minute. Try again in a few seconds.","reason":"starting"}}';
  const HELD_TEXT = 'Hornhoof did not answer for a minute. Try again in a few seconds.
';

  /* A port nothing listens on yet, and a way to bring a target up on it. */
  async function targetToCome() {
    const target = await downTarget();
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      void bodyOf(req).then(body => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, raw: req.rawHeaders, body });
        res.end('ok');
      });
    });
    const comeUp = async () => {
      onTestFinished(() => {
        server.closeAllConnections();
        server.close();
      });
      await new Promise<void>(resolve => server.listen(target.port, target.host, resolve));
    };
    return { target, seen, server, comeUp };
  }

  /* Counts the tries that failed, so a test knows the request is being held before it brings the target up. */
  function holding(extra: Partial<PassOptions> = {}) {
    let failed = 0;
    const options: Partial<PassOptions> = { holdMs: 60_000, holdEveryMs: 5, holding: () => (failed++, null), ...extra };
    return { options, failedTries: () => failed };
  }

  it('reaches the target once it is up, with its whole body', async () => {
    const { target, seen, server, comeUp } = await targetToCome();
    let connections = 0;
    server.on('connection', () => connections++);
    const { options, failedTries } = holding();
    const proxy = await through(target, options);
    const body = randomBytes(MiB);
    const answer = send(proxy, { method: 'POST', path: '/api/x' }, body);
    await vi.waitFor(() => expect(failedTries()).toBeGreaterThan(1));
    await comeUp();
    expect((await answer).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe(body.toString());
    /* The request went out on the connection that was held for it, and no other was opened. */
    expect(connections).toBe(1);
  });

  it('opens a held WebSocket once the target is up', async () => {
    const { target, server, comeUp } = await targetToCome();
    const sockets = new WebSocketServer({ server });
    sockets.on('connection', socket => socket.send('hello'));
    const { options, failedTries } = holding();
    const proxy = await through(target, options);
    const ws = new WebSocket(`ws://${proxy.host}:${proxy.port}/socket`);
    onTestFinished(() => ws.terminate());
    const heard = once(ws, 'message');
    await vi.waitFor(() => expect(failedTries()).toBeGreaterThan(1));
    await comeUp();
    expect(String((await heard)[0])).toBe('hello');
  });

  it('answers that Hornhoof did not answer once the hold ran out', async () => {
    const proxy = await through(await downTarget(), { holdMs: 30, holdEveryMs: 5 });
    const api = await send(proxy, { path: '/api/x' });
    expect(api.status).toBe(503);
    expect(api.headers['retry-after']).toBe('5');
    expect(api.headers['content-type']).toBe('application/json');
    expect(api.body).toBe(HELD_JSON);
    const page = await send(proxy, { path: '/' });
    expect(page.status).toBe(503);
    expect(page.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(page.body).toBe(HELD_TEXT);
    expect(heldAnswer({ url: '/mcp' } as http.IncomingMessage).body).toBe(HELD_JSON);
  });

  it('ends a hold with the answer holding gives, or with its own held answer', async () => {
    let asked = 0;
    const maintenance = { status: 503, headers: { 'Content-Type': 'text/plain' }, body: 'installing' };
    const proxy = await through(await downTarget(), { holdMs: 60_000, holdEveryMs: 5, holding: () => (++asked > 2 ? maintenance : null) });
    const answer = await send(proxy, { path: '/api/x' });
    expect(answer.status).toBe(503);
    expect(answer.body).toBe('installing');
    expect(asked).toBe(3);

    const own = await through(await downTarget(), { holdMs: 30, holdEveryMs: 5, held: () => ({ status: 504, headers: {}, body: 'late' }) });
    expect((await send(own, { path: '/api/x' })).body).toBe('late');
  });

  it('leaves no connection behind for a client that went away while it was held', async () => {
    const { options, failedTries } = holding();
    const { server, proxy } = await servedThrough(await downTarget(), options);
    const socket = await connected(proxy);
    socket.write('GET /api/x HTTP/1.1\r\nHost: h\r\n\r\n');
    await vi.waitFor(() => expect(failedTries()).toBeGreaterThan(1));
    socket.destroy();
    await holdsNoSocket(server);
    const tries = failedTries();
    await holdsNoSocket(server);
    await vi.waitFor(() => expect(failedTries()).toBeLessThanOrEqual(tries + 1));
  });

  it('answers 502 at once for a target that is down when it holds nothing', async () => {
    const proxy = await through(await downTarget());
    expect((await send(proxy, { path: '/api/x' })).status).toBe(502);
  });
});
