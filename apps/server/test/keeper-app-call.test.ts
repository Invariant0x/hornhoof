import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { askApp } from '../src/modules/keeper/app-call.js';

/* Only our side of HTTP: the request and a recorded response, with delivery driven by the test. */
function appDoor() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = Object.assign(new EventEmitter(), { statusCode: 200 });
  const socket = Object.assign(new EventEmitter(), { connecting: true });
  const request = Object.assign(new EventEmitter(), {
    end: () => { request.emit('socket', socket); socket.emit('connect'); },
    destroy: (error: Error) => { request.emit('error', error); request.emit('close'); return request; },
  });
  let deliver: ((res: http.IncomingMessage) => void) | undefined;
  const transport = vi.spyOn(http, 'request').mockImplementation((...args) => {
    const listener = args.find(arg => typeof arg === 'function');
    if (typeof listener !== 'function') throw new Error('The keeper asked without a response listener.');
    deliver = listener;
    return request as unknown as http.ClientRequest;
  });
  onTestFinished(() => { transport.mockRestore(); vi.useRealTimers(); });
  const headers = () => { deliver!(response as unknown as http.IncomingMessage); };
  const data = (text: string) => { response.emit('data', Buffer.from(text)); };
  const end = () => { response.emit('end'); request.emit('close'); };
  return { target: { host: 'app.test', port: 8080 }, headers, data, end };
}

describe("the keeper's call to its app", () => {
  it('gives up on a silent app at ten virtual seconds', async () => {
    const s = appDoor();
    let outcome = 'waiting';
    const answer = askApp(s.target, 'GET', '/api/network/peers').then(
      () => { outcome = 'answered'; },
      (error: unknown) => { outcome = (error as Error).message; },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('the app did not answer in ten seconds');
    await answer;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('takes a delayed answer while the virtual deadline has not elapsed', async () => {
    const s = appDoor();
    const answer = askApp(s.target, 'POST', '/api/network/report', { commit: 'worker' });
    await vi.advanceTimersByTimeAsync(9_999);
    s.headers();
    s.data('{"heard":true}');
    s.end();
    const res = await answer;
    expect([res.status, res.json()]).toEqual([200, { heard: true }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives an answer that is still arriving ten seconds after its last data', async () => {
    const s = appDoor();
    const answer = askApp(s.target, 'GET', '/api/network/peers');
    await vi.advanceTimersByTimeAsync(9_999);
    s.headers();
    await vi.advanceTimersByTimeAsync(9_999);
    s.data('{"heard":');
    await vi.advanceTimersByTimeAsync(9_999);
    s.data('true}');
    s.end();
    expect((await answer).json()).toEqual({ heard: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a pending call when the keeper stops, without advancing time', async () => {
    const s = appDoor();
    const stop = new AbortController();
    const answer = askApp(s.target, 'GET', '/api/network/peers', undefined, stop.signal);
    const refused = expect(answer).rejects.toThrow('the keeper stopped');
    stop.abort();
    await refused;
    expect(vi.getTimerCount()).toBe(0);
  });
});
