import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, Socket, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import {
  connect,
  DEFAULT_BACKOFF,
  DEFAULT_CLOCK_JUMP_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_KEEP_ALIVE_MS,
  DEFAULT_PING_MS,
  DEFAULT_SILENCE_MS,
  jitteredDelay,
  networkSnapshot,
} from '../src/connection.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { listenIn, testPort } from '../../../test-support/ports.mjs';

/* The largest setTimeout delay: a deadline of ours that cannot run out during a test. ws arms its own handshake timer on the
   real clock with handshakeTimeoutMs, so every connection that must open is given this one. */
const NEVER = 2_147_483_647;

/* The connection's pauses, ticks, pings and clock run on fake time that only the test moves; the sockets stay real. */
function fakeTime(now?: number): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], ...(now === undefined ? {} : { now }) });
}

async function listenWs(opts: { autoPong?: boolean } = {}) {
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1', ...opts });
  onTestFinished(() => server.close());
  await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  return { server, port, url: `ws://127.0.0.1:${port}` };
}

describe('connect', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses defaults that keep NAT state warm and recover within a minute', () => {
    expect(DEFAULT_BACKOFF).toEqual({ firstMs: 1_000, maxMs: 30_000 });
    expect(DEFAULT_PING_MS).toBeGreaterThanOrEqual(15_000);
    expect(DEFAULT_PING_MS).toBeLessThanOrEqual(25_000);
    expect(DEFAULT_KEEP_ALIVE_MS).toBe(15_000);
    expect(DEFAULT_CLOCK_JUMP_MS).toBe(15_000);
    expect(DEFAULT_SILENCE_MS + DEFAULT_BACKOFF.firstMs * 1.25 + DEFAULT_HANDSHAKE_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it('reconnects after the server drops it, sends node.reconnect right after hello, and enables TCP keepalive', async () => {
    const keepAliveSpy = vi.spyOn(Socket.prototype, 'setKeepAlive');
    onTestFinished(() => keepAliveSpy.mockRestore());
    const { server, url } = await listenWs();
    const keys: string[] = [];
    const frames: { conn: number; msg: Record<string, unknown> }[] = [];
    const serverCloseCodes: number[] = [];
    let connections = 0;
    server.on('connection', (socket, req) => {
      keys.push(req.headers.authorization ?? '');
      const current = ++connections;
      socket.on('message', data => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        frames.push({ conn: current, msg });
        /* The server drops the first connection once it has all the node sent on opening it. */
        if (current === 1 && msg.type === 'removed') socket.terminate();
      });
      if (current === 2) socket.on('close', code => serverCloseCodes.push(code));
    });
    const logs: string[] = [];
    let closes = 0;
    fakeTime();
    const conn = connect({
      url,
      key: 'node-key-1234567890',
      log: line => logs.push(line),
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 10, maxMs: 50 },
      onOpen(send) {
        send({ type: 'status', loggedIn: true, limits: null });
        send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] });
        send({ type: 'removed' });
      },
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());
    await eventually(() => closes === 1);
    /* The pause before the next attempt is at most maxMs (50 ms) of fake time. */
    await vi.advanceTimersByTimeAsync(50);
    await eventually(() => frames.some(f => f.conn === 2 && f.msg.type === 'removed'));

    expect(frames.filter(f => f.conn === 1).map(f => f.msg.type)).toEqual(['status', 'hello', 'removed']);
    expect(frames.filter(f => f.conn === 2).map(f => f.msg.type)).toEqual(['status', 'hello', 'node.reconnect', 'removed']);
    const report = frames.find(f => f.msg.type === 'node.reconnect')!.msg;
    expect(report).toMatchObject({
      type: 'node.reconnect',
      cause: 'abnormal_close',
      closeCode: 1006,
      closeReason: null,
      attempts: 1,
      dnsFailed: false,
      watchdogTimedOut: false,
      clockJumpMs: null,
      networkChanged: false,
    });
    expect(typeof report.offlineMs).toBe('number');
    expect(keepAliveSpy).toHaveBeenCalledWith(true, DEFAULT_KEEP_ALIVE_MS);
    expect(keys).toEqual(['Bearer node-key-1234567890', 'Bearer node-key-1234567890']);
    expect(logs.some(l => l.startsWith('Connected to Hornhoof after 1 attempt ('))).toBe(true);
    for (const line of logs) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('node-key-1234567890');
    }

    /* Clean close on an OPEN socket sends graceful close (1005) rather than a TCP reset (1006). */
    conn.close();
    await eventually(() => serverCloseCodes.length === 1);
    expect(serverCloseCodes[0]).toBe(1005);
  });

  it('detects a silent dead connection without server close, terminates it, and reconnects with watchdog_timeout', async () => {
    const { server, url } = await listenWs({ autoPong: false });
    let connections = 0;
    let clientPingsOnFirst = 0;
    const received: { conn: number; msg: Record<string, unknown> }[] = [];

    server.on('connection', socket => {
      const current = ++connections;
      socket.on('ping', data => {
        if (current === 1) clientPingsOnFirst++;
        else socket.pong(data);
      });
      socket.on('message', data => received.push({ conn: current, msg: JSON.parse(String(data)) as Record<string, unknown> }));
    });

    const logs: string[] = [];
    let socketBuilds = 0;
    let closes = 0;
    let pongs = 0;
    const clients: WebSocket[] = [];
    fakeTime();
    /* Omit monitorMs so resolveTimings derives monitorMs = floor(pingMs / 3) = 120 ms (vs 1_080 ms if / -> *), and fail retry #1. */
    const conn = connect({
      url,
      key: 'node-secret-key-abcdef',
      log: line => logs.push(line),
      pingMs: 360,
      silenceMs: 400,
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 10, maxMs: 40 },
      createSocket(target, options) {
        if (++socketBuilds === 2) throw new Error('transient retry failure');
        const ws = new WebSocket(target, options);
        ws.on('pong', () => {
          pongs++;
        });
        clients.push(ws);
        return ws;
      },
      onOpen: send => send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }),
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());

    await eventually(() => received.some(r => r.conn === 1 && r.msg.type === 'hello'));
    /* The first ping goes out at 360 ms of fake time; the server never answers it. */
    await vi.advanceTimersByTimeAsync(360);
    await eventually(() => clientPingsOnFirst >= 1);
    /* The monitor's tick at 480 ms finds 400 ms of silence and ends the connection. */
    await vi.advanceTimersByTimeAsync(120);
    await eventually(() => closes === 1);
    /* Two pauses of at most maxMs (40 ms) each: the failed rebuild's and the one before the attempt that opens. */
    await vi.advanceTimersByTimeAsync(80);
    await eventually(() => received.some(r => r.conn === 2 && r.msg.type === 'node.reconnect'));
    expect(clientPingsOnFirst).toBeGreaterThanOrEqual(1);
    const report = received.find(r => r.conn === 2 && r.msg.type === 'node.reconnect')!.msg;
    expect(report).toMatchObject({
      type: 'node.reconnect',
      cause: 'watchdog_timeout',
      watchdogTimedOut: true,
      attempts: 2,
      clockJumpMs: null,
    });
    expect(logs.some(l => l.includes('Connection closed') && l.includes('watchdog_timeout'))).toBe(true);

    /* Connection #2 answers pings with pong, so it stays alive past the silence window: the pong to its ping at 360 ms counts
       as inbound life, and no tick up to 720 ms after it opened finds 400 ms of silence. */
    await vi.advanceTimersByTimeAsync(360);
    await eventually(() => pongs === 1);
    await vi.advanceTimersByTimeAsync(360);
    expect(clients[1]!.readyState).toBe(WebSocket.OPEN);
    expect(connections).toBe(2);
  });

  it('treats server pings as inbound life even when server pongs are absent', async () => {
    const { server, url } = await listenWs({ autoPong: false });
    let connections = 0;
    let serverSocket: WebSocket | null = null;
    server.on('connection', socket => {
      connections++;
      serverSocket = socket;
    });
    let opened = false;
    let closes = 0;
    let heard = 0;
    let client: WebSocket | null = null;
    fakeTime();
    const conn = connect({
      url,
      key: 'node-secret-key-abcdef',
      pingMs: 40,
      silenceMs: 80,
      monitorMs: 15,
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 10, maxMs: 30 },
      createSocket(target, options) {
        client = new WebSocket(target, options);
        client.on('ping', () => {
          heard++;
        });
        return client;
      },
      onOpen: send => {
        opened = true;
        send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] });
      },
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());
    await eventually(() => opened && connections === 1);
    /* The server pings every 40 ms of fake time and never answers the node's pings; 160 ms is twice the 80 ms of silence. */
    for (let round = 1; round <= 4; round++) {
      await vi.advanceTimersByTimeAsync(40);
      serverSocket!.ping();
      await eventually(() => heard === round || closes > 0);
    }
    expect(closes).toBe(0);
    expect(client!.readyState).toBe(WebSocket.OPEN);
    expect(connections).toBe(1);
  });

  it('aborts a hung handshake in CONNECTING at the exact timeout boundary and terminates cleanly on close()', async () => {
    const sockets: Socket[] = [];
    const blackhole = createTcpServer(socket => {
      sockets.push(socket);
    });
    onTestFinished(() => {
      for (const s of sockets) s.destroy();
      blackhole.close();
    });
    await listenIn(blackhole);
    const port = (blackhole.address() as AddressInfo).port;

    /* Step clock: the handshake timer of the attempt never runs out on fake time, so only checkHealth at clockMs ===
       1_000 + handshakeTimeoutMs can abort; clockJumpMs as large keeps the step from counting as a sleep. */
    let clockMs = 1_000;
    let closes = 0;
    const clients: WebSocket[] = [];
    const received: Record<string, unknown>[] = [];
    fakeTime();
    const conn = connect({
      url: `ws://127.0.0.1:${port}`,
      key: 'node-secret-key-abcdef',
      now: () => clockMs,
      handshakeTimeoutMs: NEVER,
      clockJumpMs: NEVER,
      monitorMs: 15,
      backoff: { firstMs: 15, maxMs: 40 },
      createSocket(target, options) {
        const ws = new WebSocket(target, options);
        clients.push(ws);
        return ws;
      },
      onOpen: send => send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }),
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());

    await eventually(() => sockets.length === 1);
    /* Each step of the clock is followed by one tick of the monitor (15 ms of fake time). */
    clockMs = 1_000 + NEVER - 1;
    await vi.advanceTimersByTimeAsync(15);
    expect(clients[0]!.readyState).toBe(WebSocket.CONNECTING);
    clockMs = 1_000 + NEVER;
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => closes === 1);
    /* The pause before the next attempt is at most maxMs (40 ms) of fake time. */
    await vi.advanceTimersByTimeAsync(40);
    await eventually(() => sockets.length >= 2);
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => blackhole.close(() => r()));

    const wsServer = new WebSocketServer({ port, host: '127.0.0.1' });
    onTestFinished(() => wsServer.close());
    await new Promise<void>(r => wsServer.once('listening', () => r()));
    wsServer.on('connection', socket => {
      socket.on('message', data => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    });

    await eventually(() => closes === 2);
    await vi.advanceTimersByTimeAsync(40);
    await eventually(() => received.some(m => m.type === 'node.reconnect'));
    expect(received.map(m => m.type)).toEqual(['hello', 'node.reconnect']);
    expect(received[1]).toMatchObject({
      type: 'node.reconnect',
      cause: 'handshake_timeout',
    });
    expect(Number(received[1]!.attempts)).toBeGreaterThanOrEqual(2);

    /* Also verify close() while CONNECTING terminates the socket and ignores late retry callbacks. */
    const blackhole2 = createTcpServer(s => sockets.push(s));
    onTestFinished(() => {
      blackhole2.close();
    });
    await listenIn(blackhole2);
    const port2 = (blackhole2.address() as AddressInfo).port;
    const beforeCount = sockets.length;
    let clock2Ms = 0;
    let builds = 0;
    let lateRetry: (() => void) | null = null;
    const conn2 = connect({
      url: `ws://127.0.0.1:${port2}`,
      key: 'node-secret-key-abcdef',
      now: () => clock2Ms,
      handshakeTimeoutMs: NEVER,
      clockJumpMs: NEVER,
      monitorMs: 15,
      backoff: { firstMs: 10, maxMs: 20 },
      createSocket(target, options) {
        builds++;
        return new WebSocket(target, options);
      },
      scheduleRetry: fn => {
        lateRetry = fn;
        return setTimeout(() => {}, 60_000);
      },
      onOpen: () => {},
      onMessage: () => {},
    });
    await eventually(() => sockets.length > beforeCount);
    clock2Ms = NEVER;
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => lateRetry !== null);
    conn2.close();
    const afterCloseCount = sockets.length;
    expect(afterCloseCount).toBeGreaterThan(beforeCount);
    /* A retry is a synchronous build of a socket: one that came after close() builds none. */
    lateRetry!();
    expect(builds).toBe(1);
    expect(sockets.length).toBe(afterCloseCount);
  });

  it('survives a 10-minute server outage with jittered pauses between 1 s and 30 s and recovers automatically', async () => {
    const probe = createTcpServer();
    await listenIn(probe);
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));

    const startMs = 1_700_000_000_000;
    const pauses: number[] = [];

    let idx = 0;
    const samples = [0.0, 0.37, 0.81, 0.14, 0.92, 0.55, 0.23, 0.68, 0.99, 0.05, 0.44, 0.77];
    const received: Record<string, unknown>[] = [];
    fakeTime(startMs);
    const conn = connect({
      url: `ws://127.0.0.1:${port}`,
      key: 'node-secret-key-abcdef',
      monitorMs: 60_000,
      addresses: () => 'eth0:10.0.0.1',
      handshakeTimeoutMs: NEVER,
      random: () => samples[idx++ % samples.length]!,
      scheduleRetry: (fn, delayMs) => {
        pauses.push(delayMs);
        return setTimeout(fn, delayMs);
      },
      onOpen: send => send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }),
      onMessage: () => {},
    });
    onTestFinished(() => conn.close());

    /* Each refused attempt schedules a pause, and the fake clock runs it out; the pause that ends ten minutes or more after the
       start is held until the server is back. */
    const total = () => pauses.reduce((sum, pause) => sum + pause, 0);
    for (let ran = 0; ; ran++) {
      await eventually(() => pauses.length > ran);
      if (total() >= 10 * 60_000) break;
      await vi.advanceTimersByTimeAsync(pauses[ran]!);
    }
    expect(pauses[0]).toBeLessThanOrEqual(1_250);
    expect(pauses.length).toBeGreaterThanOrEqual(20);
    for (const pause of pauses) {
      expect(pause).toBeGreaterThanOrEqual(1_000);
      expect(pause).toBeLessThanOrEqual(30_000);
    }
    const capped = pauses.slice(6);
    expect(new Set(capped).size).toBeGreaterThan(3);

    const wsServer = new WebSocketServer({ port, host: '127.0.0.1' });
    onTestFinished(() => wsServer.close());
    await new Promise<void>(r => wsServer.once('listening', () => r()));
    wsServer.on('connection', socket => {
      socket.on('message', data => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    });
    await vi.advanceTimersByTimeAsync(pauses.at(-1)!);

    await eventually(() => received.some(m => m.type === 'node.reconnect'));
    expect(received.map(m => m.type)).toEqual(['hello', 'node.reconnect']);
    expect(received[1]).toMatchObject({
      type: 'node.reconnect',
      cause: 'socket_error',
      errorCode: 'ECONNREFUSED',
      dnsFailed: false,
    });
    expect(Number(received[1]!.offlineMs)).toBeGreaterThanOrEqual(10 * 60_000);
    expect(Number(received[1]!.offlineMs)).toBeLessThan(12 * 60_000);
    expect(Number(received[1]!.attempts)).toBeGreaterThanOrEqual(20);
  });

  it('probes immediately on a sleep clock jump and on network changes, keeping the largest clockJumpMs', async () => {
    const pingSpy = vi.spyOn(WebSocket.prototype, 'ping');
    onTestFinished(() => pingSpy.mockRestore());
    const { server, url } = await listenWs({ autoPong: false });
    let connections = 0;
    let pingsOnFirst = 0;
    let sleeping = false;
    let clockMs = 10_000;
    let closes = 0;
    const received: { conn: number; msg: Record<string, unknown> }[] = [];

    server.on('connection', socket => {
      const current = ++connections;
      if (current === 2) clockMs = 72_425; /* Simulate 5 ms backward NTP step before open to verify offlineMs clamps at 0. */
      socket.on('ping', data => {
        if (current === 1) pingsOnFirst++;
        if (!sleeping || current > 1) socket.pong(data);
      });
      socket.on('message', data => received.push({ conn: current, msg: JSON.parse(String(data)) as Record<string, unknown> }));
    });

    let netAddr = 'wlan0:192.168.1.10';

    fakeTime();
    const conn = connect({
      url,
      key: 'node-secret-key-abcdef',
      now: () => clockMs,
      addresses: () => netAddr,
      pingMs: 60_000,
      /* Omit probeMs with silenceMs = 4_000 (> 2_015 step) so defaultProbeMs(4_000) = 400 ms (vs 3_000 ms if / -> *). */
      silenceMs: 4_000,
      clockJumpMs: 2_000,
      monitorMs: 15,
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 10, maxMs: 50 },
      onOpen: send => send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }),
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());

    await eventually(() => connections === 1 && received.some(r => r.conn === 1 && r.msg.type === 'hello'));
    /* Each step of the clock is followed by one tick of the monitor (15 ms of fake time); a probe pings in that tick.
       Exact boundary elapsed === monitorMs + clockJumpMs (2_015) must NOT trigger a sleep probe. */
    clockMs = 12_015;
    await vi.advanceTimersByTimeAsync(15);
    expect(pingSpy).not.toHaveBeenCalled();

    /* Jump 50_000 ms (jumpMs = 50_000 - 15 = 49_985); even though 50_000 > silenceMs (4_000), probeWindowMs (400 ms) holds open! */
    sleeping = true;
    netAddr = 'wlan0:10.0.0.24';
    clockMs = 62_015;
    await vi.advanceTimersByTimeAsync(15);
    expect(pingSpy).toHaveBeenCalledTimes(1);
    await eventually(() => pingsOnFirst >= 1);
    expect(connections).toBe(1);
    clockMs = 72_030;
    await vi.advanceTimersByTimeAsync(15);
    /* Advance exact defaultProbeMs (400 ms -> 72_430, < 3_000 ms cap) so at === deadline triggers watchdog_timeout. */
    clockMs = 72_430;
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => closes === 1);
    /* The pause before the next attempt is at most maxMs (50 ms) of fake time. */
    await vi.advanceTimersByTimeAsync(50);

    await eventually(() => received.some(r => r.conn === 2 && r.msg.type === 'node.reconnect'));
    const report = received.find(r => r.conn === 2 && r.msg.type === 'node.reconnect')!.msg;
    expect(report).toMatchObject({
      type: 'node.reconnect',
      cause: 'watchdog_timeout',
      watchdogTimedOut: true,
      networkChanged: true,
      clockJumpMs: 49_985,
      offlineMs: 0,
    });
  });

  it('wakes a long retry backoff immediately when the clock jumps forward after sleep', async () => {
    const probe = createTcpServer();
    await listenIn(probe);
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(r => probe.close(() => r()));

    let clockMs = 1_700_000_000_000;
    let closes = 0;
    const received: Record<string, unknown>[] = [];

    fakeTime();
    const conn = connect({
      url: `ws://127.0.0.1:${port}`,
      key: 'node-secret-key-abcdef',
      now: () => clockMs,
      clockJumpMs: 1_000,
      monitorMs: 15,
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 25_000, maxMs: 30_000 },
      onOpen: send => send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }),
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());

    /* The refused first attempt leaves a pause of 25 s to 30 s before the next. */
    await eventually(() => closes === 1);
    const wsServer = new WebSocketServer({ port, host: '127.0.0.1' });
    onTestFinished(() => wsServer.close());
    await new Promise<void>(r => wsServer.once('listening', () => r()));
    wsServer.on('connection', socket => {
      socket.on('message', data => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    });

    /* The clock jumps a minute; one tick of the monitor (15 ms of fake time, far short of the pause) starts the next attempt. */
    clockMs += 60_000;
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => received.some(m => m.type === 'node.reconnect'));
    expect(Number(received[1]!.clockJumpMs)).toBeGreaterThanOrEqual(55_000);
  });

  it('never stops retrying after 401, 4001, or exceptions in onOpen, onMessage, onRefused, and log', async () => {
    let allowHttp = false;
    const httpServer = createHttpServer((_req, res) => {
      res.writeHead(401).end('Unauthorized Bearer secret-header-value');
    });
    const wss = new WebSocketServer({ noServer: true });
    onTestFinished(() => {
      wss.close();
      httpServer.close();
    });
    httpServer.on('upgrade', (req, socket, head) => {
      if (!allowHttp) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
    await listenIn(httpServer);
    const port = (httpServer.address() as AddressInfo).port;

    /* Also verify 401 without optional log/onRefused handlers works cleanly. */
    fakeTime();
    let quietCloses = 0;
    const quietConn = connect({
      url: `ws://127.0.0.1:${port}`,
      key: 'node-quiet-key-123456',
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 20, maxMs: 40 },
      onOpen: () => {},
      onMessage: () => {},
      onClose: () => {
        quietCloses++;
      },
    });
    await eventually(() => quietCloses === 1);
    quietConn.close();

    let wsConns = 0;
    let activeServerSocket: WebSocket | null = null;
    const received: Record<string, unknown>[] = [];
    wss.on('connection', ws => {
      activeServerSocket = ws;
      const current = ++wsConns;
      ws.on('message', data => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        received.push(msg);
        /* Hornhoof disconnects the machine once the second connection has said all it says on opening. */
        if (current === 2 && msg.type === 'node.reconnect') ws.close(4001, 'Disconnected key=node-secret-key-99999999');
      });
    });

    let openCalls = 0;
    let msgCalls = 0;
    let refusedCalls = 0;
    let logCalls = 0;
    let closes = 0;
    const logs: string[] = [];
    const messages: string[] = [];

    const conn = connect({
      url: `ws://127.0.0.1:${port}`,
      key: 'node-secret-key-99999999',
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 15, maxMs: 60 },
      onClose: () => {
        closes++;
      },
      log(line) {
        logs.push(line);
        if (++logCalls === 1) throw new Error('logger boom');
      },
      onRefused() {
        if (++refusedCalls === 1) throw new Error('onRefused boom');
      },
      onOpen(send) {
        if (++openCalls === 1) throw new Error('onOpen boom');
        send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] });
      },
      onMessage(m) {
        if (++msgCalls === 1) throw new Error('onMessage boom');
        messages.push(m.type);
      },
    });
    onTestFinished(() => conn.close());

    /* Each refusal or failure leaves a pause of at most maxMs (60 ms) of fake time before the next attempt. */
    await eventually(() => refusedCalls >= 1 && closes === 1);
    allowHttp = true;
    await vi.advanceTimersByTimeAsync(60); /* #1: onOpen throws */
    await eventually(() => closes === 2);
    await vi.advanceTimersByTimeAsync(60); /* #2: hello, then 4001 */
    await eventually(() => closes === 3);
    await vi.advanceTimersByTimeAsync(60); /* #3 */
    await eventually(() => wsConns === 3 && received.filter(m => m.type === 'node.reconnect').length === 2);
    expect(received.filter(m => m.type === 'hello')).toHaveLength(2);
    expect(refusedCalls).toBe(2);

    activeServerSocket!.send(JSON.stringify({ type: 'login.stop' }));
    activeServerSocket!.send(JSON.stringify({ type: 'programs.update' }));
    await eventually(() => messages.includes('programs.update'));

    const lastReconnect = received.findLast(m => m.type === 'node.reconnect')!;
    expect(lastReconnect).toMatchObject({
      type: 'node.reconnect',
      cause: 'server_close',
      closeCode: 4001,
    });
    expect(String(lastReconnect.closeReason)).not.toContain('node-secret-key-99999999');
    for (const line of logs) {
      expect(line).not.toContain('\n');
      expect(line).not.toContain('node-secret-key-99999999');
      expect(line).not.toContain('secret-header-value');
    }
  });

  it('preserves first-attempt DNS error, error text, and network change across subsequent non-DNS retry failures', async () => {
    const sockets: Socket[] = [];
    const blackhole = createTcpServer(s => sockets.push(s));
    onTestFinished(() => {
      for (const s of sockets) s.destroy();
      blackhole.close();
    });
    await listenIn(blackhole);
    const blackholePort = (blackhole.address() as AddressInfo).port;

    let attempts = 0;
    let netAddr = 'eth0:192.168.0.5';
    let clockMs = 1_000;
    let closes = 0;
    const logs: string[] = [];
    const received: Record<string, unknown>[] = [];

    fakeTime();
    const conn = connect({
      url: `ws://hornhoof-test.invalid:${blackholePort}`,
      key: 'node-secret-key-abcdef',
      log: line => logs.push(line),
      addresses: () => netAddr,
      now: () => clockMs,
      handshakeTimeoutMs: NEVER,
      clockJumpMs: NEVER,
      monitorMs: 15,
      backoff: { firstMs: 15, maxMs: 35 },
      onClose: () => {
        closes++;
      },
      lookup: ((_hostname, lookupOpts, cb) => {
        const current = ++attempts;
        if (current === 1) {
          netAddr = 'eth0:10.0.0.9';
          const err = Object.assign(new Error('getaddrinfo ENOTFOUND hornhoof-test.invalid'), { code: 'ENOTFOUND' });
          cb(err, '', 4);
          return;
        }
        if (typeof lookupOpts === 'object' && lookupOpts.all) {
          (cb as unknown as (err: null, addrs: { address: string; family: number }[]) => void)(null, [{ address: '127.0.0.1', family: 4 }]);
          return;
        }
        cb(null, '127.0.0.1', 4);
      }) as NonNullable<Parameters<typeof connect>[0]['lookup']>,
      onOpen: send => send({ type: 'hello', version: '0.6.1', loggedIn: true, running: [] }),
      onMessage: () => {},
    });
    onTestFinished(() => conn.close());

    /* Attempt #1 fails with ENOTFOUND; the monitor's first tick (15 ms of fake time) sees the network change and starts attempt
       #2 at once. Its handshake to the blackhole times out (errorCode: null) at the tick after the clock reaches its deadline. */
    await eventually(() => closes === 1);
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => sockets.length === 1);
    clockMs = 1_000 + NEVER;
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => closes === 2);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(logs.filter(l => l.startsWith('Connection closed'))).toHaveLength(2);
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => blackhole.close(() => r()));

    const wsServer = new WebSocketServer({ port: blackholePort, host: '127.0.0.1' });
    onTestFinished(() => wsServer.close());
    await new Promise<void>(r => wsServer.once('listening', () => r()));
    wsServer.on('connection', ws => {
      ws.on('message', data => received.push(JSON.parse(String(data)) as Record<string, unknown>));
    });

    /* The pause before the next attempt is at most maxMs (35 ms) of fake time. */
    await vi.advanceTimersByTimeAsync(35);
    await eventually(() => received.some(m => m.type === 'node.reconnect'));
    const report = received.find(m => m.type === 'node.reconnect')!;
    expect(report).toMatchObject({
      type: 'node.reconnect',
      cause: 'dns_error',
      errorCode: 'ENOTFOUND',
      error: 'getaddrinfo ENOTFOUND hornhoof-test.invalid',
      dnsFailed: true,
      watchdogTimedOut: false,
      networkChanged: true,
    });
    expect(Number(report.attempts)).toBeGreaterThanOrEqual(3);
    expect(logs.some(l => l.includes('Connection closed (dns_error, code 1006): getaddrinfo ENOTFOUND'))).toBe(true);
    expect(logs.some(l => /Connected to Hornhoof after [3-9] attempts \(/.test(l))).toBe(true);
  });

  it('clears pending sleep/network flags when a probe succeeds so a later server restart reports clean state', async () => {
    expect(
      networkSnapshot(() => ({
        wlan0: undefined,
        lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
        eth0: [{ address: '10.1.2.3', netmask: '255.255.255.0', family: 'IPv4', mac: '00:11:22:33:44:55', internal: false, cidr: '10.1.2.3/24' }],
      })),
    ).toBe('eth0:10.1.2.3');
    expect(
      networkSnapshot(() => {
        throw new Error('sandbox denied');
      }),
    ).toBe('');
    expect(jitteredDelay(1_000, 1_000, 30_000, () => 0)).toBe(1_000);
    expect(jitteredDelay(30_000, 1_000, 30_000, () => 0.999999)).toBe(30_000);

    const { server, url } = await listenWs();
    let connections = 0;
    let latestServerWs: WebSocket | null = null;
    const received: { conn: number; msg: Record<string, unknown> }[] = [];
    server.on('connection', ws => {
      const current = ++connections;
      latestServerWs = ws;
      ws.on('message', data => received.push({ conn: current, msg: JSON.parse(String(data)) as Record<string, unknown> }));
    });

    let clockMs = 1_700_000_000_000;
    let netAddr = 'eth0:10.0.0.1';
    let createCalls = 0;
    let closes = 0;
    let pongs = 0;
    let client: WebSocket | null = null;
    let latestSend: ((m: { type: 'removed' }) => boolean) | null = null;

    fakeTime();
    const conn = connect({
      url,
      key: 'node-secret-key-abcdef',
      now: () => clockMs,
      addresses: () => netAddr,
      pingMs: 2_000,
      silenceMs: 5_000,
      clockJumpMs: 1_000,
      monitorMs: 15,
      probeMs: 120,
      handshakeTimeoutMs: NEVER,
      backoff: { firstMs: 10, maxMs: 30 },
      createSocket(target, options) {
        if (++createCalls === 1) throw new Error('synchronous constructor failure');
        client = new WebSocket(target, options);
        client.on('pong', () => {
          pongs++;
        });
        return client;
      },
      /* Omit hello here to verify fallback delivery of node.reconnect right after onOpen returns. */
      onOpen(send) {
        latestSend = send;
      },
      onMessage: () => {},
      onClose: () => {
        closes++;
      },
    });
    onTestFinished(() => conn.close());

    /* The failed build leaves a pause of at most maxMs (30 ms) of fake time. */
    await vi.advanceTimersByTimeAsync(30);
    await eventually(() => received.some(r => r.conn === 1 && r.msg.type === 'node.reconnect'));
    expect(received[0]!.msg).toMatchObject({
      type: 'node.reconnect',
      cause: 'socket_error',
      error: 'synchronous constructor failure',
      attempts: 2,
    });

    /* Clock jumps 10 s + network changes while server auto-pongs: probe succeeds, socket stays open, flags clear. One tick of the
       monitor (15 ms of fake time) probes; after the pong, the tick at the end of the probe window (120 ms) finds no silence. */
    netAddr = 'eth0:10.0.0.2';
    clockMs += 10_000;
    await vi.advanceTimersByTimeAsync(15);
    await eventually(() => pongs === 1);
    clockMs += 120;
    await vi.advanceTimersByTimeAsync(15);
    expect(client!.readyState).toBe(WebSocket.OPEN);
    expect(connections).toBe(1);

    /* Now server restarts cleanly (1012): reconnect report must NOT carry stale sleep/network flags from the survived probe. */
    latestServerWs!.close(1012, 'Server restarting');
    await eventually(() => closes === 1);
    await vi.advanceTimersByTimeAsync(30);
    await eventually(() => received.some(r => r.conn === 2 && r.msg.type === 'node.reconnect'));
    const secondReport = received.find(r => r.conn === 2 && r.msg.type === 'node.reconnect')!.msg;
    expect(secondReport).toMatchObject({
      type: 'node.reconnect',
      cause: 'server_close',
      closeCode: 1012,
      closeReason: 'Server restarting',
      clockJumpMs: null,
      networkChanged: false,
    });

    expect(latestSend!({ type: 'removed' })).toBe(true);
    /* close() leaves the socket CLOSING at once, so the sender refuses right after it. */
    conn.close();
    expect(latestSend!({ type: 'removed' })).toBe(false);
  });
});
