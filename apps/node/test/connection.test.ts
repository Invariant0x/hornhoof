import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
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
    const opened: number[] = [];
    const closed: number[] = [];
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
      onOpen: (send, generation) => {
        opened.push(generation);
        send({ type: 'hello', version: '0.2.0', loggedIn: true, running: [] });
      },
      onMessage: () => {},
      onClose: generation => closed.push(generation),
    });
    onTestFinished(() => conn.close());
    const end = Date.now() + 3000;
    while (hellos.length < 2 && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    expect(hellos).toEqual(['hello', 'hello']);
    expect(opened).toEqual([1, 2]);
    expect(closed).toEqual([1]);
    expect(keys).toEqual(['Bearer node-key-1234567890', 'Bearer node-key-1234567890']);
  });
});
