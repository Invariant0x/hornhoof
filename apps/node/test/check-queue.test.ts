import { afterEach, describe, expect, it } from 'vitest';
import { CheckSlotQueue as CheckQueue } from '@hornhoof/protocol';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient, withCheckSlot, currentCheckSignal } from '../src/check-queue.js';
import { deferred } from '../../../test-support/deferred.mjs';
afterEach(() => setCheckClient(null));

describe('the machine check queue', () => {
  it('holds checks above capacity, reports FIFO positions and starts the next check on release', async () => {
    const queue = new CheckQueue(() => 1);
    const first = deferred(), second = deferred();
    const started: string[] = [], positions: number[] = [];
    const a = queue.withSlot(async () => { started.push('a'); await first.promise; });
    const b = queue.withSlot(async () => { started.push('b'); await second.promise; }, { onPosition: p => positions.push(p) });
    const c = queue.withSlot(async () => { started.push('c'); }, { onPosition: p => positions.push(p) });
    await Promise.resolve();
    expect(started).toEqual(['a']);
    expect(positions).toEqual([1, 2]);
    first.resolve(); await a;
    expect(started).toEqual(['a', 'b']);
    expect(positions).toContain(1);
    second.resolve(); await Promise.all([b, c]);
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('frees the slot after a failing command and removes cancelled waiters', async () => {
    const queue = new CheckQueue(() => 1);
    const first = deferred();
    const a = queue.withSlot(async () => { await first.promise; throw new Error('command failed'); });
    const rejected = expect(a).rejects.toThrow('command failed');
    const cancelled = new AbortController();
    let ran = false;
    const b = queue.withSlot(async () => { ran = true; }, { signal: cancelled.signal });
    const aborted = expect(b).rejects.toThrow();
    const c = queue.withSlot(async () => 'next');
    cancelled.abort(); await aborted;
    first.resolve(); await rejected;
    expect(await c).toBe('next');
    expect(ran).toBe(false);
  });

  it('uses all available slots, waits while capacity is zero, and starts on a refreshed measurement', async () => {
    let capacity = 0;
    const queue = new CheckQueue(() => capacity);
    const hold = deferred(), started: number[] = [];
    const runs = [1, 2, 3].map(n => queue.withSlot(async () => { started.push(n); await hold.promise; }));
    await Promise.resolve(); expect(started).toEqual([]);
    capacity = 2; queue.refresh();
    await Promise.resolve(); expect(started).toEqual([1, 2]);
    hold.resolve(); await Promise.all(runs);
    expect(started).toEqual([1, 2, 3]);
  });

  it('rejects an already cancelled check before running or reporting it', async () => {
    const queue = new CheckQueue(() => 1), cancel = new AbortController();
    cancel.abort(new Error('stopped'));
    let ran = false;
    await expect(queue.withSlot(async () => { ran = true; }, { signal: cancel.signal })).rejects.toThrow('stopped');
    expect(ran).toBe(false);
  });

  it('does not leave a queued command behind when its position output fails', async () => {
    let capacity = 0;
    const queue = new CheckQueue(() => capacity);
    let ran = false;
    await expect(queue.withSlot(async () => { ran = true; }, { onPosition: () => { throw new Error('output closed'); } })).rejects.toThrow('output closed');
    capacity = 1;
    queue.refresh(); await Promise.resolve();
    expect(ran).toBe(false);
    expect(await queue.withSlot(async () => 'next')).toBe('next');
  });

  it('reuses the current slot for a nested check instead of waiting on itself', async () => {
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const result = withCheckSlot(async () => withCheckSlot(async () => 'nested'));
    expect(await result).toBe('nested');
  });

  it('keeps an aborted running slot occupied until the command and its children have finished', async () => {
    const queue = new CheckQueue(() => 1), cancel = new AbortController();
    const started = deferred(), stopped = deferred();
    let nextRan = false;
    const run = queue.withSlot(async () => { started.resolve(); await stopped.promise; return 'stopped'; }, { signal: cancel.signal });
    await started.promise;
    const next = queue.withSlot(async () => { nextRan = true; });
    cancel.abort(new Error('stop process group'));
    await Promise.resolve();
    expect(nextRan).toBe(false);
    stopped.resolve();
    expect(await run).toBe('stopped');
    await next;
    expect(nextRan).toBe(true);
  });

  it('preserves the exact cancellation reason and never runs a cancelled waiter', async () => {
    const queue = new CheckQueue(() => 0), cancel = new AbortController();
    const reason = { code: 'deadline' };
    let ran = false;
    const run = queue.withSlot(async () => { ran = true; }, { signal: cancel.signal });
    cancel.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(ran).toBe(false);
  });

  it('does not start a command cancelled between receiving a slot and entering its callback', async () => {
    const queue = new CheckQueue(() => 1), cancel = new AbortController();
    let ran = false;
    const reason = new Error('cancelled before command start');
    const run = queue.withSlot(async () => { ran = true; }, { signal: cancel.signal });
    cancel.abort(reason);
    await expect(run).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(await queue.withSlot(async () => 'next')).toBe('next');
  });

  it('keeps other waiters when a position callback cancels itself and then throws', async () => {
    let capacity = 0, firstRan = false;
    const queue = new CheckQueue(() => capacity), cancel = new AbortController();
    const first = queue.withSlot(async () => { firstRan = true; });
    const reason = new Error('stopped');
    const second = queue.withSlot(async () => {}, { signal: cancel.signal, onPosition: () => { cancel.abort(reason); throw new Error('output closed'); } });
    await expect(second).rejects.toBe(reason);
    capacity = 1; queue.refresh(); await Promise.resolve();
    expect(firstRan).toBe(true);
    await first;
  });

  it('passes a nested deadline to the command while retaining its parent lease', async () => {
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const started = deferred(), finished = deferred(), cancel = new AbortController();
    let childSignal: AbortSignal | undefined, ambientSignal: AbortSignal | undefined;
    const pending = withCheckSlot(async () => withCheckSlot(async signal => { childSignal = signal; ambientSignal = currentCheckSignal(); started.resolve(); await finished.promise; }, { signal: cancel.signal }));
    await started.promise;
    cancel.abort();
    try { expect(ambientSignal).toBe(childSignal); expect(childSignal?.aborted).toBe(true); }
    finally { finished.resolve(); await pending; }
  });
});
