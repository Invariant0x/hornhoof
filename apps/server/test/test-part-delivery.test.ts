import { describe, expect, it } from 'vitest';
import { BUILTIN, nodeIdentity } from '../src/modules/nodes/hub.js';
import { PartDeliveries, RECEIVE_MS } from '../src/modules/testruns/delivery.js';

/* Timers the test runs by hand: nothing scheduled runs until the test fires it. */
function handTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    set: (run: () => void, ms: number) => { pending.set(++next, { run, ms }); return next; },
    clear: (handle: unknown) => { pending.delete(handle as number); },
    pending,
    fireAll: () => { for (const [handle, timer] of [...pending]) { pending.delete(handle); timer.run(); } },
  };
}

const part = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const ann = nodeIdentity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const bob = nodeIdentity('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

describe('parts sent to a machine that has not said yet it got them', () => {
  it('gives a machine seconds, no more than ten, to say it got a part', () => {
    expect(RECEIVE_MS).toBeGreaterThanOrEqual(1_000);
    expect(RECEIVE_MS).toBeLessThanOrEqual(10_000);
  });

  it('falls due once its time is over, and only once', () => {
    const sent = new PartDeliveries(() => {}, handTimers());
    sent.expect(part, ann, 1_000);
    expect(sent.due(1_000 + RECEIVE_MS - 1)).toEqual([]);
    expect(sent.due(1_000 + RECEIVE_MS)).toEqual([{ partId: part, node: ann }]);
    expect(sent.due(1_000 + 100 * RECEIVE_MS)).toEqual([]);
  });

  it('counts the first word from the machine it went to, and no later word or word from another machine', () => {
    const sent = new PartDeliveries(() => {}, handTimers());
    sent.expect(part, ann, 0);
    expect(sent.received(part, bob)).toBe(false);
    expect(sent.received(other, ann)).toBe(false);
    expect(sent.received(part, ann)).toBe(true);
    expect(sent.received(part, ann)).toBe(false);
    expect(sent.due(100 * RECEIVE_MS)).toEqual([]);
  });

  it('binds a part to the machine it went to last', () => {
    const sent = new PartDeliveries(() => {}, handTimers());
    sent.expect(part, ann, 0);
    sent.expect(part, BUILTIN, 5_000);
    expect(sent.received(part, ann)).toBe(false);
    expect(sent.due(RECEIVE_MS)).toEqual([]);
    expect(sent.due(5_000 + RECEIVE_MS)).toEqual([{ partId: part, node: BUILTIN }]);
  });

  it('wakes its owner when a part falls due, and keeps no timer for a part it no longer waits for', () => {
    const timers = handTimers();
    let woken = 0;
    const sent = new PartDeliveries(() => { woken++; }, timers);
    sent.expect(part, ann, 0);
    expect([...timers.pending.values()].map(t => t.ms)).toEqual([RECEIVE_MS]);
    timers.fireAll();
    expect(woken).toBe(1);

    sent.expect(other, bob, 0);
    sent.received(other, bob);
    sent.expect(part, ann, 0);
    sent.forget(part);
    expect(timers.pending.size).toBe(0);
    sent.expect(part, ann, 0);
    sent.expect(other, bob, 0);
    sent.close();
    expect(timers.pending.size).toBe(0);
    expect(sent.due(100 * RECEIVE_MS)).toEqual([]);
  });
});
