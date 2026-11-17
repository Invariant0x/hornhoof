import { createServer } from 'node:net';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { listenAt } from '../../../test-support/ports.mjs';
import { prepareSharedDatabase } from './helpers-db.js';
import { ask, company, hasLeader, worker } from './worker-keeper-fixture.js';
import { controlledTime, until } from './worker-keeper-time.js';

const stolen = vi.hoisted(() => ({ port: 0, active: false }));
vi.mock('../../../test-support/ports.mjs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../test-support/ports.mjs')>();
  return { ...actual, testPort: (host?: string) => stolen.active ? Promise.resolve(stolen.port) : actual.testPort(host) };
});

await prepareSharedDatabase();
beforeEach(controlledTime);

/* Another process takes a probe's port after it closes, before the keeper can bind it. The real listener keeps it. */
async function stealProbe(): Promise<void> {
  const server = createServer(socket => socket.destroy());
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  stolen.port = await listenAt(port => new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(port); });
  }));
  stolen.active = true;
  onTestFinished(() => { stolen.active = false; });
}

describe('the worker keeper fixture', () => {
  it('starts the company when another process has taken the port a probe released', async () => {
    await stealProbe();
    const c = await company();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    expect(c.peerPort).not.toBe(stolen.port);
    expect((await ask(w.front, { path: '/api/health' })).status).toBe(200);
    expect(c.lines.filter(line => line.includes('EADDRINUSE'))).toEqual([]);
  });

  it('starts a worker when another process has taken the port a probe released', async () => {
    const c = await company();
    await stealProbe();
    const w = await worker(c);
    await until(() => hasLeader(w.status()));
    expect(w.front).not.toBe(stolen.port);
    expect((await ask(w.front, { path: '/api/health' })).status).toBe(200);
    expect(w.lines.filter(line => line.includes('EADDRINUSE'))).toEqual([]);
  });
});
