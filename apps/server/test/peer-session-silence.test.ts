import { EventEmitter } from 'node:events';
import type { ClientHttp2Session } from 'node:http2';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { heldSession, PeerSessions, type DialTarget, type Hello } from '../src/net/peer-sessions.js';

/* A worker's session to a data machine on a slow link (#1137): a long copy brings its bytes at 20 KB/s, and behind them
   the answers to the session's hellos and pings come too late. The session ends only once nothing at all came on it for
   half a minute, and says why. On a recorded link and the controlled clock. */

const MACHINE = 'aaaaaaaa-0000-4000-8000-00000000000a';
const TARGET: DialTarget = { machine: MACHINE, networkId: `77aa0011${'1'.repeat(56)}`, addresses: [], peerPort: null, relayPort: null };
const HELLO: Hello = { machine: MACHINE, role: 'data', lead: true, commit: 'c0ffee', seen: '127.0.0.1', term: { number: 7, machine: MACHINE, split: false }, sync: null, moving: null };
const ENDED = `The direct session to data machine ${MACHINE} ended: nothing came on it for 30 s.`;

/* The link as the session sees it: every hello asked and every ping sent stays unanswered, and the bytes that came on
   the connection are what the test says came. */
function slowLink() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  onTestFinished(() => { vi.useRealTimers(); });
  const link = { bytes: 0, hellos: 0, pings: 0 };
  const h2 = Object.assign(new EventEmitter(), {
    destroyed: false,
    request: () => {
      link.hellos++;
      /* A hello that is asked and never answered: it ends only when the session gives up on it. */
      const stream: EventEmitter & { end(): void; close(): void } = Object.assign(new EventEmitter(), { end: () => undefined, close: () => void stream.emit('close') });
      return stream;
    },
    ping: () => (link.pings++, true),
    destroy: () => {
      if (h2.destroyed) return;
      h2.destroyed = true;
      h2.emit('close');
    },
    close: () => h2.destroy(),
  });
  const said: string[] = [];
  const sessions = new PeerSessions({ held: () => null, key: { publicPem: '', privatePem: '' }, revoked: () => new Set(), own: () => [], log: line => said.push(line) });
  onTestFinished(() => sessions.close());
  sessions.use([TARGET]);
  sessions['keep'](sessions['kept'][0]!, heldSession(h2 as unknown as ClientHttp2Session, 'direct', HELLO, () => link.bytes));
  /* Bytes come every second, for as many seconds as given. */
  const flowing = async (seconds: number) => {
    for (let second = 0; second < seconds; second++) {
      link.bytes += 20_000;
      await vi.advanceTimersByTimeAsync(1000);
    }
  };
  return { link, h2, sessions, said, flowing };
}

describe('a session to a data machine on a slow link', () => {
  it('stays while bytes come on it, though none of its hellos and pings is answered', async () => {
    const s = slowLink();
    await s.flowing(120);
    expect(s.link.hellos).toBeGreaterThanOrEqual(10);
    expect(s.link.pings).toBeGreaterThanOrEqual(1);
    expect(s.h2.destroyed).toBe(false);
    expect(s.sessions.leader()).toMatchObject({ machine: MACHINE, path: 'direct' });
    expect(s.said).toEqual([]);
  });

  it('ends once nothing came on it for 30 s, and says why in one line', async () => {
    const s = slowLink();
    /* The last bytes are seen at the look of second 10; from then on the link is gone without a word. */
    await s.flowing(10);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.h2.destroyed).toBe(false);
    expect(s.said).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.h2.destroyed).toBe(true);
    expect(s.sessions.leader()).toBeNull();
    expect(s.said).toEqual([ENDED]);
  });

  it('ends a session that is silent from its start at 30 s', async () => {
    const s = slowLink();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(s.h2.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.h2.destroyed).toBe(true);
    expect(s.said).toEqual([ENDED]);
  });

  it('says why when the other side ends it, and when it is let go of', async () => {
    const s = slowLink();
    s.h2.destroy();
    expect(s.said).toEqual([`The direct session to data machine ${MACHINE} ended: the other side or the network closed it.`]);
    const t = slowLink();
    t.sessions.use([]);
    expect(t.said).toEqual([`The direct session to data machine ${MACHINE} ended: the machine is no longer among those this one keeps sessions to.`]);
  });
});
