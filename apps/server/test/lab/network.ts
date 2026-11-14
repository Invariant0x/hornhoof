import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { onTestFinished, vi } from 'vitest';
import { listenIn, testPort } from '../../../../test-support/ports.mjs';

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

const START_WALL_MS = Date.UTC(2026, 10, 14, 12, 0, 0);

export const realSchedule: Schedule = {
  now: () => performance.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, Math.max(0, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
  noteLocal: work => work,
};

async function flushIo(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/* Virtual time with real loopback I/O: timers, Date, performance and AbortSignal.timeout obey virtual milliseconds,
   while setImmediate stays on the event loop so local sockets move bytes without real-clock pauses. */
export function virtualClock(opts: { keep?: boolean; startWall?: number } = {}): VirtualClock {
  const startWall = opts.startWall ?? START_WALL_MS;
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: startWall });
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
    AbortSignal.timeout = realTimeout;
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
      await flushIo(3);
      await drainLocal();
      await vi.advanceTimersByTimeAsync(slice);
      await drainLocal();
      await flushIo(3);
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

/* A port in this worker's corridor where nothing listens, so a direct LAN dial gets an immediate refusal. */
export async function closedPort(host = '127.0.0.1'): Promise<number> {
  return testPort(host);
}

/* Initial zero-delay stand before controllable latency and cuts are wired in: passes HTTP and sockets straight through,
   as the lab on a single host did when it hid the real-run timing bugs. */
export function createDelayGate(opts: { oneWayMs?: number; cut?: boolean; schedule?: Schedule; keep?: boolean } = {}): DelayGate {
  const schedule = opts.schedule ?? realSchedule;
  let oneWay = opts.oneWayMs ?? 0;
  let isCut = opts.cut ?? false;
  const stats: DelayStats = { httpRequests: 0, chunks: 0, bytes: 0, cuts: 0 };
  const closers: Array<() => Promise<void>> = [];
  const close = async (): Promise<void> => {
    await Promise.all(closers.splice(0).map(fn => fn().catch(() => undefined)));
  };
  if (!opts.keep) onTestFinished(() => close());
  return {
    schedule,
    oneWayMs: () => oneWay,
    setOneWayMs: ms => void (oneWay = Math.max(0, ms)),
    cut: () => isCut,
    setCut: next => void (isCut = next),
    stats: () => ({ ...stats }),
    wait: async () => true,
    splice: (a, b) => {
      a.pipe(b);
      b.pipe(a);
    },
    httpProxy: async (targetUrl, proxyOpts = {}) => {
      const base = new URL(targetUrl);
      const server = http.createServer((req, res) => {
        stats.httpRequests += 1;
        proxyOpts.beforeForward?.(req);
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const out = http.request(
            { hostname: base.hostname, port: base.port, path: req.url, method: req.method, headers: req.headers },
            up => {
              res.writeHead(up.statusCode ?? 502, up.headers);
              up.pipe(res);
            },
          );
          out.on('error', () => res.writeHead(502).end());
          out.end(Buffer.concat(chunks));
        });
      });
      const host = proxyOpts.host ?? '127.0.0.1';
      const port = await listenIn(server, host);
      const stop = () => new Promise<void>(resolve => (server.closeAllConnections(), server.close(() => resolve())));
      closers.push(stop);
      return { url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`, port, close: stop };
    },
    tcpProxy: async (target, proxyOpts = {}) => {
      const server = net.createServer(client => {
        const upstream = net.connect(target.port, target.host);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      const port = await listenIn(server, proxyOpts.host ?? '127.0.0.1');
      const stop = () => new Promise<void>(resolve => server.close(() => resolve()));
      closers.push(stop);
      return { port, close: stop };
    },
    close,
  };
}

export async function createPeerRelay(gate: DelayGate, opts: { host?: string; keep?: boolean } = {}): Promise<PeerRelay> {
  const host = opts.host ?? '127.0.0.1';
  const server = net.createServer(socket => socket.destroy());
  const port = await listenIn(server, host);
  const closers: Array<() => Promise<void>> = [() => new Promise<void>(resolve => server.close(() => resolve()))];
  const close = async (): Promise<void> => {
    await Promise.all(closers.splice(0).map(fn => fn().catch(() => undefined)));
  };
  if (!opts.keep) onTestFinished(() => close());
  return {
    host,
    port,
    gate,
    offer: async () => ({ close: async () => undefined }),
    visit: async (services, visitOpts = {}) => {
      const ports: Record<string, number> = {};
      for (const name of services) {
        const listener = net.createServer(socket => socket.destroy());
        ports[name] = await listenIn(listener, visitOpts.host ?? '127.0.0.1');
        closers.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
      }
      return { ports, close: async () => undefined };
    },
    close,
  };
}
