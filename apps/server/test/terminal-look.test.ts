import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { Ctx } from '../src/app.js';
import type { NodeIdentity } from '../src/modules/nodes/hub.js';
import { keepLooking } from '../src/modules/terminals/look.js';
import { CLOSE } from '../src/modules/terminals/relay.js';

type Close = readonly [number, string];
const PING_MS = 100;

/* An open view and its looks, each of which stays open until the test says what it saw. */
function view() {
  const looks: ((close: Close | null) => void)[] = [];
  const closed = vi.fn();
  const pinged = vi.fn();
  const told: (() => void)[] = [];
  const onClose: (() => void)[] = [];
  const socket = { readyState: 1, ping: pinged, close: closed, on: (_event: string, then: () => void) => onClose.push(then) } as unknown as WebSocket;
  const ctx = {
    config: { streamPingMs: PING_MS },
    bus: { onAccessChange: (_company: string, then: () => void) => { told.push(then); return () => {}; } },
    terminals: { remove: () => true },
    hub: { send: vi.fn() },
  } as unknown as Ctx;
  const why = vi.fn(() => new Promise<Close | null>(done => { looks.push(done); }));
  const mayGoOn = keepLooking(ctx, socket, { termId: 't', node: {} as NodeIdentity, companyId: 'c' }, why);
  return { why, looks, closed, pinged, mayGoOn, accessChanged: () => told[0]!(), hangUp: () => onClose[0]!() };
}
const saw = async (looks: ((close: Close | null) => void)[], close: Close | null) => {
  looks.shift()!(close);
  await vi.advanceTimersByTimeAsync(0);
};

describe('how an open view looks at whether it may go on', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('one look at a time, however many pings come while it runs, and one after it', async () => {
    const v = view();
    await vi.advanceTimersByTimeAsync(PING_MS * 5);
    expect(v.why).toHaveBeenCalledTimes(1);
    await saw(v.looks, null);
    expect(v.why).toHaveBeenCalledTimes(2);
    await saw(v.looks, null);
    expect(v.why).toHaveBeenCalledTimes(2);
    v.hangUp();
  });

  it('again after a look that ran when access changed, as it may have read from before', async () => {
    const v = view();
    await vi.advanceTimersByTimeAsync(PING_MS);
    v.accessChanged();
    expect(v.why).toHaveBeenCalledTimes(1);
    await saw(v.looks, null);
    expect(v.why).toHaveBeenCalledTimes(2);
    await saw(v.looks, CLOSE.noAccess);
    expect(v.closed).toHaveBeenCalledExactlyOnceWith(...CLOSE.noAccess);
    v.hangUp();
  });

  it('holds a late frame for a look that began after the frame came', async () => {
    const v = view();
    await vi.advanceTimersByTimeAsync(PING_MS);
    await vi.advanceTimersByTimeAsync(1000);
    let answer: boolean | null = null;
    void v.mayGoOn().then(may => { answer = may; });
    await saw(v.looks, null);
    expect(answer).toBeNull();
    await saw(v.looks, CLOSE.noAccess);
    expect(answer).toBe(false);
    v.hangUp();
  });

  it('lets a frame go at once right after a look', async () => {
    const v = view();
    await expect(v.mayGoOn()).resolves.toBe(true);
    expect(v.why).not.toHaveBeenCalled();
    v.hangUp();
  });

  it('counts a look that fails as no access', async () => {
    const v = view();
    v.why.mockRejectedValueOnce(new Error('down'));
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(v.closed).toHaveBeenCalledExactlyOnceWith(...CLOSE.noAccess);
    v.hangUp();
  });

  it('stops looking when the view is gone', async () => {
    const v = view();
    v.hangUp();
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(v.why).not.toHaveBeenCalled();
  });

  it('sends a WebSocket keepalive ping on every check so an idle link stays open for 30 minutes', async () => {
    const v = view();
    /* 30 minutes at the default 25 s streamPingMs is 72 keepalive checks with zero closes. */
    const ticks = 72;
    for (let i = 0; i < ticks; i++) {
      await vi.advanceTimersByTimeAsync(PING_MS);
      await saw(v.looks, null);
    }
    expect(v.pinged).toHaveBeenCalledTimes(ticks);
    expect(v.closed).not.toHaveBeenCalled();
    v.hangUp();
  });

  it('sends no keepalive ping when a look ends the view or after the socket closes', async () => {
    const denied = view();
    await vi.advanceTimersByTimeAsync(PING_MS);
    await saw(denied.looks, CLOSE.noAccess);
    expect(denied.closed).toHaveBeenCalledExactlyOnceWith(...CLOSE.noAccess);
    expect(denied.pinged).not.toHaveBeenCalled();
    denied.hangUp();

    const gone = view();
    await vi.advanceTimersByTimeAsync(PING_MS);
    gone.hangUp();
    await saw(gone.looks, null);
    expect(gone.pinged).not.toHaveBeenCalled();
  });
});
