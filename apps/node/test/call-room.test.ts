import { describe, expect, it } from 'vitest';
import { CallRoom } from '../src/call-room.js';

/* Whether the promise has settled once everything already due has run. */
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await new Promise(resolve => setImmediate(resolve));
  return done;
};

describe('the room one-shot calls start in', () => {
  it('starts every call at once while the machine reports no kill for want of memory, with no count of its own', async () => {
    const room = new CallRoom(() => false);
    const seats = Array.from({ length: 500 }, () => room.enter(new AbortController().signal));
    for (const seat of seats) expect(await settled(seat)).toBe(true);
  });

  it('keeps new calls waiting in their order while the last report says the kernel killed for want of memory, and starts them once a report says none', async () => {
    let short = true;
    const room = new CallRoom(() => short);
    const first = room.enter(new AbortController().signal), second = room.enter(new AbortController().signal);
    expect(await settled(first)).toBe(false);
    expect(await settled(second)).toBe(false);
    /* Looking again while the machine still says so starts none. */
    room.look();
    expect(await settled(first)).toBe(false);
    short = false;
    room.look();
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  it('lets a waiting call go when it is stopped, and the ones behind it move up', async () => {
    let short = true;
    const room = new CallRoom(() => short);
    const stop = new AbortController();
    const stopped = room.enter(stop.signal), next = room.enter(new AbortController().signal);
    stop.abort();
    await expect(stopped).rejects.toThrow();
    expect(await settled(next)).toBe(false);
    short = false;
    room.look();
    expect(await settled(next)).toBe(true);
  });

  it('refuses a call stopped before it asks', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(new CallRoom(() => false).enter(stop.signal)).rejects.toThrow();
  });
});
