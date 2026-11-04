import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { connect } from '../src/connection.js';

describe('connect', () => {
  it('reconnects after the server drops it and says hello on every open', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    onTestFinished(() => server.close());
    await new Promise(r => server.once('listening', r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const keys: string[] = [];
    const hellos: string[] = [];
    let connections = 0;
    server.on('connection', (socket, req) => {
      keys.push(req.headers.authorization ?? '');
      connections++;
      socket.on('message', data => hellos.push(JSON.parse(String(data)).type));
      if (connections === 1) setTimeout(() => socket.terminate(), 20);
    });
    const conn = connect({
      url,
      key: 'node-key-1234567890',
      backoff: { firstMs: 10, maxMs: 50 },
      onOpen: send => send({ type: 'hello', version: '0.2.0', loggedIn: true, running: [] }),
      onMessage: () => {},
    });
    onTestFinished(() => conn.close());
    const end = Date.now() + 3000;
    while (hellos.length < 2 && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    expect(hellos).toEqual(['hello', 'hello']);
    expect(keys).toEqual(['Bearer node-key-1234567890', 'Bearer node-key-1234567890']);
  });
});

/* A port nothing listens on: the connection is refused at once. */
async function closedPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as AddressInfo;
  await new Promise(r => probe.close(r));
  return port;
}

/* Runs a connection against a server that refuses it and gives the pauses it waited between tries, with the clock under
   the test's hand. Only setTimeout is faked, so the sockets still run on real time. */
async function waitsOf(url: string, tries: number): Promise<number[]> {
  const realImmediate = setImmediate;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => void vi.useRealTimers());
  const waits: number[] = [];
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    /* The connection's own pause is the one that reopens the socket; ws keeps timers of its own. */
    if (ms !== undefined && fn.name === 'open') waits.push(ms);
    return timeout(fn, ms);
  }) as typeof setTimeout);
  const conn = connect({ url, key: 'node-key-1234567890', onOpen: () => {}, onMessage: () => {} });
  onTestFinished(() => conn.close());
  for (let seen = 0; seen < tries; seen++) {
    while (waits.length <= seen) await new Promise(r => realImmediate(r));
    await vi.advanceTimersByTimeAsync(waits[seen]!);
  }
  return waits;
}

describe('connect backoff', () => {
  it('waits at most 10 s between tries', async () => {
    const waits = await waitsOf(`ws://127.0.0.1:${await closedPort()}`, 6);
    expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });

  it('waits 60 s after the server refused the key', async () => {
    const refusing = createHttpServer();
    refusing.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'));
    await new Promise<void>(r => refusing.listen(0, '127.0.0.1', r));
    onTestFinished(() => void refusing.close());
    const waits = await waitsOf(`ws://127.0.0.1:${(refusing.address() as AddressInfo).port}`, 1);
    expect(waits[0]).toBe(60_000);
  });

  it('waits 60 s after a close with 4001', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    onTestFinished(() => server.close());
    await new Promise(r => server.once('listening', r));
    server.on('connection', socket => socket.close(4001, 'Disconnected.'));
    const waits = await waitsOf(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, 1);
    expect(waits[0]).toBe(60_000);
  });

  it('gives up a handshake that gets no answer', async () => {
    const silent = createTcpServer();
    let connections = 0;
    silent.on('connection', socket => {
      connections++;
      socket.on('error', () => {});
    });
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', r));
    onTestFinished(() => void silent.close());
    const conn = connect({ url: `ws://127.0.0.1:${(silent.address() as AddressInfo).port}`, key: 'node-key-1234567890', backoff: { firstMs: 10, handshakeMs: 300 }, onOpen: () => {}, onMessage: () => {} });
    onTestFinished(() => conn.close());
    const end = Date.now() + 3000;
    while (connections < 2 && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    expect(connections).toBeGreaterThanOrEqual(2);
  });
});

describe('connect acks', () => {
  async function openedWith(confirms: boolean): Promise<boolean> {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    onTestFinished(() => server.close());
    await new Promise(r => server.once('listening', r));
    if (confirms) server.on('headers', headers => headers.push('Hornhoof-Acks: 1'));
    const opened = new Promise<boolean>(resolve => {
      const conn = connect({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, key: 'node-key-1234567890', onOpen: (_send, acks) => resolve(acks), onMessage: () => {} });
      onTestFinished(() => conn.close());
    });
    return opened;
  }

  it('knows a server that confirms', async () => {
    expect(await openedWith(true)).toBe(true);
    expect(await openedWith(false)).toBe(false);
  });
});
