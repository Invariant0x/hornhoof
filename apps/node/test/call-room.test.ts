import { describe, expect, it } from 'vitest';
import { CALL_BYTES, CallRoom } from '../src/call-room.js';

/* Whether the promise has settled once everything already due has run. */
const settled = async (p: Promise<unknown>) => {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  await new Promise(resolve => setImmediate(resolve));
  return done;
};

describe('the room one-shot calls start in', () => {
  it('starts every call at once while the memory a new program gets holds them all, with no count of its own', async () => {
    const room = new CallRoom(() => 1000 * CALL_BYTES);
    const seats = Array.from({ length: 500 }, () => room.enter(new AbortController().signal));
    for (const seat of seats) expect(await settled(seat)).toBe(true);
  });

  it('counts a call that started against the memory until its program says its first word, then the memory it takes shows', async () => {
    let free = 2.5 * CALL_BYTES;
    const room = new CallRoom(() => free);
    const one = await room.enter(new AbortController().signal);
    const two = await room.enter(new AbortController().signal);
    const three = room.enter(new AbortController().signal);
    expect(await settled(three)).toBe(false);
    /* The two programs are up and hold their memory, which the machine's own measure shows from now on. */
    free = 1.2 * CALL_BYTES;
    one.settled();
    two.settled();
    expect(await settled(three)).toBe(true);
  });

  it('keeps a call waiting in its turn while memory is short, and starts it once a call ends or the machine has room', async () => {
    let free = 0.5 * CALL_BYTES;
    const room = new CallRoom(() => free);
    /* Where no call runs, one starts all the same, so a small machine is never left with none. */
    const first = await room.enter(new AbortController().signal);
    first.settled();
    const second = room.enter(new AbortController().signal), third = room.enter(new AbortController().signal);
    expect(await settled(second)).toBe(false);
    first.leave();
    expect(await settled(second)).toBe(true);
    expect(await settled(third)).toBe(false);
    free = 5 * CALL_BYTES;
    room.look();
    expect(await settled(third)).toBe(true);
  });

  it('lets a waiting call go when it is stopped, and the ones behind it move up', async () => {
    const room = new CallRoom(() => 0);
    const running = await room.enter(new AbortController().signal);
    const stop = new AbortController();
    const stopped = room.enter(stop.signal), next = room.enter(new AbortController().signal);
    stop.abort();
    await expect(stopped).rejects.toThrow();
    running.leave();
    expect(await settled(next)).toBe(true);
  });
});
