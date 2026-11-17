import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { PeerSessions } from '../src/net/peer-sessions.js';
import { until } from './helpers-basic.js';

function peerStream() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const stream = Object.assign(new PassThrough(), { setTimeout: () => stream });
  const sessions = new PeerSessions({ held: () => null, key: { publicPem: '', privatePem: '' }, revoked: () => new Set(), own: () => [], log: () => undefined });
  /* A recorded HTTP/2 transport: the real stream method still owns its request, delivery and deadline. */
  sessions['leading'] = () => ({ session: { h2: { request: () => stream } } }) as unknown as NonNullable<ReturnType<typeof sessions['leading']>>;
  onTestFinished(() => { stream.destroy(); });
  return { stream, sessions };
}

describe('the peer stream deadline', () => {
  it('cuts an idle stream at thirty virtual seconds', async () => {
    const s = peerStream();
    const answer = s.sessions.stream('GET', '/peer/backups/bundle');
    let error: Error | undefined;
    s.stream.on('error', err => { error = err; });
    s.stream.emit('response', { ':status': 200 });
    await answer;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(error?.message).toBe('The stream to the leader stopped moving.');
    expect(s.stream.destroyed).toBe(true);
  });

  it('keeps all body bytes and renews the deadline as they arrive', async () => {
    const s = peerStream();
    const answer = s.sessions.stream('GET', '/peer/backups/bundle');
    s.stream.emit('response', { ':status': 200, 'content-length': '2' });
    const res = await answer;
    const bytes = buffer(res.body);
    s.stream.write('a');
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(29_999);
    s.stream.write('b');
    await new Promise<void>(resolve => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(29_999);
    s.stream.end();
    expect(await bytes).toEqual(Buffer.from('ab'));
    expect(res.length).toBe(2);
    await until(() => vi.getTimerCount() === 0);
  });
});
