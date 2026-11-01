import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { NodeHub } from '../src/modules/nodes/hub.js';
import type { UsageConnection } from '../src/modules/subscriptions/quota.js';

describe('sampling epochs on actual socket entries', () => {
  it('does not give a replaced socket the new connection authority after an asynchronous wait', async () => {
    const entries: UsageConnection[] = [];
    const checked: boolean[] = [];
    const errors: unknown[] = [];
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const hub = new NodeHub({ pingMs: 60_000, onClose: async () => {}, onError: error => errors.push(error), onMessage: async (_id, message, connection) => {
      if (message.type !== 'hello') return;
      entries.push(connection);
      if (entries.length === 1) await wait;
      checked.push(connection.current());
    } });
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const clients: WebSocket[] = [];
    onTestFinished(async () => {
      release();
      hub.stop();
      for (const client of clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await once(server, 'listening');
    const id = { kind: 'node' as const, subscriptionId: '00000000-0000-4000-8000-000000000062' };
    server.on('connection', socket => hub.attach(id, socket));
    const connect = async () => {
      const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      clients.push(client);
      await once(client, 'open');
      client.send(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], usageObservations: true }));
    };
    await connect();
    await expect.poll(() => entries.length).toBe(1);
    expect(entries[0]!.current()).toBe(true);
    await connect();
    await expect.poll(() => entries.length).toBe(2);
    expect(entries[1]!.epoch).not.toBe(entries[0]!.epoch);
    expect(entries[0]!.current()).toBe(false);
    expect(entries[1]!.current()).toBe(true);
    release();
    await expect.poll(() => checked.length).toBe(2);
    expect(checked).toEqual([true, false]);
    expect(errors).toEqual([]);
  });
});
