import { generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { onTestFinished, vi } from 'vitest';
import { listenIn } from '../../../../test-support/ports.mjs';
import type { MachineKey } from '../../src/modules/keeper/machine-keys.js';

/* A clock and timer source for the network stand: virtual in unit tests, and the process clock in the Docker lab. */
export type Schedule = {
  now(): number;
  after(ms: number, fn: () => void): () => void;
  noteLocal<T>(work: Promise<T>): Promise<T>;
};

export type VirtualClock = {
  schedule: Schedule;
  now(): number;
  clocks(): { wall: number; mono: number };
  advance(ms: number, stepMs?: number): Promise<void>;
  flush(turns?: number): Promise<void>;
  until(ready: () => boolean | Promise<boolean>, opts?: { maxMs?: number; stepMs?: number }): Promise<void>;
  restore(): void;
};

export type DelayStats = {
  httpRequests: number;
  chunks: number;
  bytes: number;
  cuts: number;
};

export type HttpProxy = {
  url: string;
  port: number;
  close(): Promise<void>;
};

export type DelayGate = {
  schedule: Schedule;
  oneWayMs(): number;
  setOneWayMs(ms: number): void;
  cut(): boolean;
  setCut(cut: boolean): void;
  stats(): DelayStats;
  wait(hops?: number): Promise<boolean>;
  splice(a: Duplex, b: Duplex): void;
  httpProxy(targetUrl: string, opts?: { hops?: number; host?: string; beforeForward?: (req: http.IncomingMessage) => void }): Promise<HttpProxy>;
  tcpProxy(target: { host: string; port: number }, opts?: { host?: string }): Promise<{ port: number; close(): Promise<void> }>;
  close(): Promise<void>;
};

export type PeerOffer = {
  close(): Promise<void>;
};

export type PeerVisitor = {
  ports: Record<string, number>;
  close(): Promise<void>;
};

export type PeerRelay = {
  host: string;
  port: number;
  gate: DelayGate;
  offer(services: Record<string, { host: string; port: number }>): Promise<PeerOffer>;
  visit(services: string[], opts?: { host?: string }): Promise<PeerVisitor>;
  close(): Promise<void>;
};

const realDateNow = Date.now.bind(Date);
/* One hour behind real wall time so X.509 certificates minted after minutes of virtual-clock advancement still satisfy
   OpenSSL's C-level notBefore <= time(NULL) check while remaining well before their multi-day notAfter expiry. Virtual
   TLS scenarios advancing more than an hour must pass an earlier startWall. */
const OPENSSL_SKEW_MS = 3_600_000;
const ignore = (): void => {};

export const realSchedule: Schedule = {
  now: () => performance.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, Math.max(0, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
  noteLocal: work => work,
};

async function flushIo(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function patchAbortTimeout(): () => void {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  AbortSignal.timeout = (ms: number): AbortSignal => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      controller.abort(err);
    }, ms);
    timer.unref?.();
    return controller.signal;
  };
  return () => {
    AbortSignal.timeout = realTimeout;
  };
}

/* Virtual time with real loopback I/O: timers, Date, performance and AbortSignal.timeout obey virtual milliseconds,
   while setImmediate stays on the event loop so local sockets move bytes without real-clock pauses. */
export function virtualClock(opts: { keep?: boolean; startWall?: number } = {}): VirtualClock {
  const startWall = opts.startWall ?? realDateNow() - OPENSSL_SKEW_MS;
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: startWall });
  const unpatchAbort = patchAbortTimeout();
  const pending = new Set<Promise<unknown>>();
  const drainLocal = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all([...pending]);
  };
  const schedule: Schedule = {
    now: () => performance.now(),
    after: (ms, fn) => {
      const timer = setTimeout(fn, Math.max(0, ms));
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    noteLocal: <T>(work: Promise<T>): Promise<T> => {
      const tracked = work.finally(() => pending.delete(tracked));
      pending.add(tracked);
      return work;
    },
  };
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    unpatchAbort();
    vi.useRealTimers();
  };
  if (!opts.keep) onTestFinished(restore);
  const advance = async (ms: number, stepMs = 25): Promise<void> => {
    let left = Math.max(0, ms);
    if (left === 0) {
      await flushIo(4);
      await drainLocal();
      return;
    }
    while (left > 0) {
      const slice = Math.min(stepMs, left);
      await flushIo(6);
      await drainLocal();
      await flushIo(4);
      await vi.advanceTimersByTimeAsync(slice);
      await drainLocal();
      await flushIo(6);
      left -= slice;
    }
  };
  return {
    schedule,
    now: () => Date.now() - startWall,
    clocks: () => ({ wall: Date.now(), mono: performance.now() }),
    advance,
    flush: flushIo,
    until: async (ready, waitOpts = {}) => {
      const maxMs = waitOpts.maxMs ?? 15_000;
      const stepMs = waitOpts.stepMs ?? 25;
      let spent = 0;
      while (!(await ready())) {
        if (spent >= maxMs) throw new Error(`Condition did not hold within ${maxMs} ms of virtual time.`);
        const slice = Math.min(stepMs, maxMs - spent);
        await advance(slice, slice);
        spent += slice;
      }
    },
    restore,
  };
}

export function ed25519Key(): MachineKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

function readRequestBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.once('end', () => resolve(Buffer.concat(chunks)));
    req.once('error', () => resolve(null));
  });
}

function forwardHttp(base: URL, req: http.IncomingMessage, body: Buffer): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer } | null> {
  return new Promise(resolve => {
    const headers: http.IncomingHttpHeaders = { ...req.headers, host: base.host };
    delete headers['transfer-encoding'];
    delete headers.connection;
    delete headers['keep-alive'];
    if (body.length > 0 || headers['content-length'] !== undefined) headers['content-length'] = String(body.length);
    const out = http.request({ hostname: base.hostname, port: base.port, path: req.url, method: req.method, headers, agent: false }, up => {
      const chunks: Buffer[] = [];
      up.on('data', (chunk: Buffer) => chunks.push(chunk));
      up.once('end', () => {
        const replyBody = Buffer.concat(chunks);
        const replyHeaders: http.IncomingHttpHeaders = { ...up.headers };
        delete replyHeaders['transfer-encoding'];
        delete replyHeaders.connection;
        delete replyHeaders['keep-alive'];
        replyHeaders['content-length'] = String(replyBody.length);
        resolve({ status: up.statusCode ?? 502, headers: replyHeaders, body: replyBody });
      });
      up.once('error', () => resolve(null));
    });
    out.on('socket', socket => socket.setNoDelay(true));
    out.once('error', () => resolve(null));
    out.end(body);
  });
}

type GateInternals = {
  schedule: Schedule;
  oneWayMs: () => number;
  cut: () => boolean;
  stats: DelayStats;
  onCut: Set<() => void>;
};

function pipeDelayed(from: Duplex, to: Duplex, g: GateInternals): () => void {
  const queue: Array<{ due: number; fn: () => void }> = [];
  let lastDue = g.schedule.now();
  let cancelTimer: (() => void) | null = null;
  const clearAll = (): void => {
    queue.length = 0;
    if (cancelTimer) {
      const cancel = cancelTimer;
      cancelTimer = null;
      cancel();
    }
  };
  const arm = (): void => {
    if (cancelTimer || queue.length === 0) return;
    const waitMs = Math.max(0, Math.ceil(queue[0]!.due - g.schedule.now()));
    cancelTimer = g.schedule.after(waitMs, flush);
  };
  const flush = (): void => {
    cancelTimer = null;
    if (g.cut()) {
      queue.length = 0;
      return;
    }
    const now = g.schedule.now();
    while (queue.length > 0 && queue[0]!.due <= now) {
      queue.shift()!.fn();
      if (g.cut()) {
        queue.length = 0;
        return;
      }
    }
    arm();
  };
  const enqueue = (fn: () => void): void => {
    const now = g.schedule.now();
    const due = Math.max(lastDue, now + g.oneWayMs());
    lastDue = due;
    queue.push({ due, fn });
    arm();
  };
  from.on('data', (chunk: Buffer) => {
    if (g.cut() || to.destroyed) {
      g.stats.cuts += 1;
      clearAll();
      from.destroy();
      to.destroy();
      return;
    }
    const copy = Buffer.from(chunk);
    g.stats.chunks += 1;
    g.stats.bytes += copy.length;
    enqueue(() => {
      if (!to.destroyed && !to.writableEnded) to.write(copy);
    });
  });
  from.once('end', () => enqueue(() => void (!to.destroyed && to.end())));
  from.once('close', () => {
    if (!from.readableEnded) enqueue(() => to.destroy());
  });
  return clearAll;
}

function spliceDelayed(a: Duplex, b: Duplex, g: GateInternals): void {
  a.on('error', ignore);
  b.on('error', ignore);
  if (g.cut()) {
    g.stats.cuts += 1;
    a.destroy();
    b.destroy();
    return;
  }
  const stopA = pipeDelayed(a, b, g);
  const stopB = pipeDelayed(b, a, g);
  const cutNow = (): void => {
    g.stats.cuts += 1;
    stopA();
    stopB();
    a.destroy();
    b.destroy();
  };
  g.onCut.add(cutNow);
  let closed = 0;
  const onDone = (): void => {
    closed += 1;
    if (closed >= 2) g.onCut.delete(cutNow);
  };
  a.once('close', onDone);
  b.once('close', onDone);
}

/* Controllable one-way latency and instant path cuts for HTTP relays and bidirectional TCP/TLS/HTTP2 streams. */
export function createDelayGate(opts: { oneWayMs?: number; cut?: boolean; schedule?: Schedule; keep?: boolean } = {}): DelayGate {
  const schedule = opts.schedule ?? realSchedule;
  let oneWay = Math.max(0, opts.oneWayMs ?? 0);
  let isCut = opts.cut ?? false;
  const stats: DelayStats = { httpRequests: 0, chunks: 0, bytes: 0, cuts: 0 };
  const onCut = new Set<() => void>();
  const closers: Array<() => Promise<void>> = [];
  const internals: GateInternals = { schedule, oneWayMs: () => oneWay, cut: () => isCut, stats, onCut };

  const waitOneHop = (): Promise<boolean> => {
    if (isCut) {
      stats.cuts += 1;
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      const cutHop = (): void => {
        onCut.delete(cutHop);
        cancel();
        stats.cuts += 1;
        resolve(false);
      };
      const cancel = schedule.after(oneWay, () => {
        onCut.delete(cutHop);
        resolve(!isCut);
      });
      onCut.add(cutHop);
    });
  };

  const wait = async (hops = 1): Promise<boolean> => {
    for (let i = 0; i < hops; i++) {
      if (!(await waitOneHop())) return false;
    }
    return true;
  };

  const setCut = (next: boolean): void => {
    isCut = next;
    if (!next) return;
    for (const drop of [...onCut]) drop();
  };

  const close = async (): Promise<void> => {
    setCut(true);
    await Promise.all(closers.splice(0).map(fn => fn().catch(() => undefined)));
  };
  if (!opts.keep) onTestFinished(() => close());

  return {
    schedule,
    oneWayMs: () => oneWay,
    setOneWayMs: ms => void (oneWay = Math.max(0, ms)),
    cut: () => isCut,
    setCut,
    stats: () => ({ ...stats }),
    wait,
    splice: (a, b) => spliceDelayed(a, b, internals),
    httpProxy: async (targetUrl, proxyOpts = {}) => {
      const base = new URL(targetUrl);
      const hops = proxyOpts.hops ?? 1;
      const server = http.createServer((req, res) => {
        req.on('error', ignore);
        res.on('error', ignore);
        void (async () => {
          const body = await schedule.noteLocal(readRequestBody(req));
          if (body === null) return void req.socket.destroy();
          stats.httpRequests += 1;
          if (!(await wait(hops)) || req.socket.destroyed) return void req.socket.destroy();
          proxyOpts.beforeForward?.(req);
          const reply = await schedule.noteLocal(forwardHttp(base, req, body));
          if (!(await wait(hops)) || req.socket.destroyed || res.writableEnded) return void req.socket.destroy();
          const delivered = new Promise<void>(resolve => {
            res.once('finish', resolve);
            res.once('close', resolve);
          });
          void schedule.noteLocal(delivered);
          if (!reply) return void res.writeHead(502).end();
          res.writeHead(reply.status, reply.headers).end(reply.body);
        })();
      });
      server.on('connection', socket => socket.setNoDelay(true));
      const host = proxyOpts.host ?? '127.0.0.1';
      const port = await listenIn(server, host);
      const stop = () => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve())));
      closers.push(stop);
      return { url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, port, close: stop };
    },
    tcpProxy: async (target, proxyOpts = {}) => {
      const sockets = new Set<net.Socket>();
      const server = net.createServer({ noDelay: true }, client => {
        client.setNoDelay(true);
        sockets.add(client);
        client.once('close', () => sockets.delete(client));
        if (isCut) {
          stats.cuts += 1;
          client.destroy();
          return;
        }
        const upstream = net.connect({ port: target.port, host: target.host, noDelay: true });
        sockets.add(upstream);
        upstream.once('close', () => sockets.delete(upstream));
        spliceDelayed(client, upstream, internals);
      });
      const port = await listenIn(server, proxyOpts.host ?? '127.0.0.1');
      const stop = () =>
        new Promise<void>(resolve => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        });
      closers.push(stop);
      return { port, close: stop };
    },
    close,
  };
}

type OfferEntry =
  | { kind: 'local'; host: string; port: number; sockets: Set<net.Socket> }
  | { kind: 'remote'; control: net.Socket; sockets: Set<net.Socket> };

function readLineHeader(socket: net.Socket, onHeader: (header: Record<string, string>, rest: Buffer) => void): void {
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(10);
    if (nl < 0) {
      if (buf.length > 4096) socket.destroy();
      return;
    }
    socket.off('data', onData);
    try {
      const parsed = JSON.parse(buf.subarray(0, nl).toString('utf8')) as Record<string, string>;
      onHeader(parsed, buf.subarray(nl + 1));
    } catch {
      socket.destroy();
    }
  };
  socket.on('data', onData);
}

/* Stand-in for frps stcp peer relay: carries unread TLS/HTTP2 streams between machines through a DelayGate, both
   in-process (offer/visit) and over TCP lines (for keeper containers in the Docker lab). */
export async function createPeerRelay(gate: DelayGate, opts: { host?: string; keep?: boolean } = {}): Promise<PeerRelay> {
  const host = opts.host ?? '127.0.0.1';
  const offers = new Map<string, OfferEntry>();
  const knocks = new Map<string, { visitor: net.Socket; initial: Buffer; entry: OfferEntry }>();
  const allSockets = new Set<net.Socket>();
  const closers: Array<() => Promise<void>> = [];

  const dropEntry = (service: string, entry: OfferEntry): void => {
    if (offers.get(service) === entry) offers.delete(service);
    for (const s of entry.sockets) s.destroy();
    if (entry.kind === 'remote') entry.control.destroy();
  };

  const connectVisitor = (service: string, visitor: net.Socket, initial: Buffer = Buffer.alloc(0)): void => {
    visitor.setNoDelay(true);
    visitor.on('error', ignore);
    const entry = offers.get(service);
    if (gate.cut() || !entry) {
      if (gate.cut()) gate.splice(visitor, visitor);
      visitor.destroy();
      return;
    }
    entry.sockets.add(visitor);
    visitor.once('close', () => entry.sockets.delete(visitor));
    if (entry.kind === 'local') {
      const upstream = net.connect({ port: entry.port, host: entry.host, noDelay: true });
      entry.sockets.add(upstream);
      upstream.once('close', () => entry.sockets.delete(upstream));
      gate.splice(visitor, upstream);
      if (initial.length > 0) visitor.unshift(initial);
      return;
    }
    const token = randomUUID();
    knocks.set(token, { visitor, initial, entry });
    visitor.once('close', () => knocks.delete(token));
    entry.control.write(`${JSON.stringify({ knock: token })}\n`);
  };

  const server = net.createServer({ noDelay: true }, socket => {
    socket.setNoDelay(true);
    socket.on('error', ignore);
    allSockets.add(socket);
    socket.once('close', () => allSockets.delete(socket));
    readLineHeader(socket, (msg, rest) => {
      if (msg.op === 'offer' && msg.service) {
        const prev = offers.get(msg.service);
        if (prev) dropEntry(msg.service, prev);
        const entry: OfferEntry = { kind: 'remote', control: socket, sockets: new Set() };
        offers.set(msg.service, entry);
        socket.once('close', () => dropEntry(msg.service!, entry));
      } else if (msg.op === 'accept' && msg.token) {
        const waiting = knocks.get(msg.token);
        knocks.delete(msg.token);
        if (!waiting || waiting.visitor.destroyed) return void socket.destroy();
        waiting.entry.sockets.add(socket);
        socket.once('close', () => waiting.entry.sockets.delete(socket));
        gate.splice(waiting.visitor, socket);
        if (waiting.initial.length > 0) waiting.visitor.unshift(waiting.initial);
        if (rest.length > 0) socket.unshift(rest);
      } else if (msg.op === 'visit' && msg.service) {
        connectVisitor(msg.service, socket, rest);
      } else {
        socket.destroy();
      }
    });
  });

  const port = await listenIn(server, host);
  closers.push(
    () =>
      new Promise<void>(resolve => {
        for (const [service, entry] of [...offers]) dropEntry(service, entry);
        for (const s of allSockets) s.destroy();
        server.close(() => resolve());
      }),
  );

  const close = async (): Promise<void> => {
    await Promise.all(closers.splice(0).map(fn => fn().catch(() => undefined)));
  };
  if (!opts.keep) onTestFinished(() => close());

  return {
    host,
    port,
    gate,
    offer: async services => {
      const registered: Array<[string, OfferEntry]> = [];
      for (const [name, target] of Object.entries(services)) {
        const prev = offers.get(name);
        if (prev) dropEntry(name, prev);
        const entry: OfferEntry = { kind: 'local', host: target.host, port: target.port, sockets: new Set() };
        offers.set(name, entry);
        registered.push([name, entry]);
      }
      return {
        close: async () => {
          for (const [name, entry] of registered) dropEntry(name, entry);
        },
      };
    },
    visit: async (services, visitOpts = {}) => {
      const ports: Record<string, number> = {};
      const listeners: net.Server[] = [];
      const sockets = new Set<net.Socket>();
      for (const name of services) {
        const listener = net.createServer({ noDelay: true }, visitor => {
          visitor.setNoDelay(true);
          sockets.add(visitor);
          visitor.once('close', () => sockets.delete(visitor));
          connectVisitor(name, visitor);
        });
        ports[name] = await listenIn(listener, visitOpts.host ?? '127.0.0.1');
        listeners.push(listener);
      }
      const stop = async (): Promise<void> => {
        for (const s of sockets) s.destroy();
        await Promise.all(listeners.map(l => new Promise<void>(resolve => l.close(() => resolve()))));
      };
      closers.push(stop);
      return { ports, close: stop };
    },
    close,
  };
}
