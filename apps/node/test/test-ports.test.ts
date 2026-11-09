import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CORRIDOR, corridorShare, listenIn, testPort } from '../../../test-support/ports.mjs';

const open: Server[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(server => new Promise(resolve => { server.close(resolve); }))); });

describe('the port corridor of tests', () => {
  it('gives each test worker its own share of one narrow corridor below the ports the system hands out', () => {
    expect(corridorShare({ VITEST_POOL_ID: '1' }, 0)).toEqual({ first: 24000, last: 24061 });
    expect(corridorShare({ VITEST_POOL_ID: '16' }, 0)).toEqual({ first: 24930, last: 24991 });
    expect(corridorShare({ VITEST_POOL_ID: '17' }, 0)).toEqual(corridorShare({ VITEST_POOL_ID: '1' }, 0));
    expect(corridorShare({}, 35)).toEqual(corridorShare({ VITEST_POOL_ID: '4' }, 0));
    expect(CORRIDOR.first + CORRIDOR.size).toBeLessThanOrEqual(32768);
  });

  it('passes over a port in use, tries only ports of its share, and stops at any other failure', async () => {
    const { first, last } = corridorShare(), tried: number[] = [];
    /* A server whose first two ports are taken, as another process may hold them. */
    const busy = Object.assign(new EventEmitter(), {
      listen(port: number) { tried.push(port); queueMicrotask(() => tried.length < 3 ? busy.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' })) : busy.emit('listening')); },
    });
    const port = await listenIn(busy as unknown as Server);
    expect(tried).toHaveLength(3);
    expect(port).toBe(tried[2]);
    expect(new Set(tried).size).toBe(3);
    for (const each of tried) { expect(each).toBeGreaterThanOrEqual(first); expect(each).toBeLessThanOrEqual(last); }
    const denied = Object.assign(new EventEmitter(), { listen() { queueMicrotask(() => denied.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }))); } });
    await expect(listenIn(denied as unknown as Server)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('names a free port of its share for a server that takes its port when it is made', async () => {
    const { first, last } = corridorShare(), port = await testPort();
    expect(port).toBeGreaterThanOrEqual(first);
    expect(port).toBeLessThanOrEqual(last);
    const server = createServer();
    open.push(server);
    await new Promise<void>(resolve => { server.listen(port, '127.0.0.1', resolve); });
  });
});
