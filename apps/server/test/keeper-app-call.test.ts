import http from 'node:http';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { askApp } from '../src/modules/keeper/app-call.js';
import { until } from './helpers-basic.js';

async function appDoor() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => vi.useRealTimers());
  const requests: http.ServerResponse[] = [];
  const server = http.createServer((_req, res) => requests.push(res));
  const port = await listenIn(server);
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { target: { host: '127.0.0.1', port }, requests };
}

describe("the keeper's call to its app", () => {
  it('gives up on a silent app at ten virtual seconds', async () => {
    const s = await appDoor();
    let outcome = 'waiting';
    const answer = askApp(s.target, 'GET', '/api/network/peers').then(
      () => { outcome = 'answered'; },
      (error: unknown) => { outcome = (error as Error).message; },
    );
    await until(() => s.requests.length === 1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(outcome).toBe('the app did not answer in ten seconds');
    await answer;
  });

  it('takes a delayed answer while the virtual deadline has not elapsed', async () => {
    const s = await appDoor();
    const answer = askApp(s.target, 'POST', '/api/network/report', { commit: 'worker' });
    await until(() => s.requests.length === 1);
    await vi.advanceTimersByTimeAsync(9_999);
    s.requests[0]!.end(JSON.stringify({ heard: true }));
    const res = await answer;
    expect([res.status, res.json()]).toEqual([200, { heard: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a pending call when the keeper stops, without advancing time', async () => {
    const s = await appDoor();
    const stop = new AbortController();
    const answer = askApp(s.target, 'GET', '/api/network/peers', undefined, stop.signal);
    const refused = expect(answer).rejects.toThrow('the keeper stopped');
    await until(() => s.requests.length === 1);
    stop.abort();
    await refused;
    await until(() => vi.getTimerCount() === 0);
  });
});
