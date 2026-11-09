import { afterEach, expect, it, vi } from 'vitest';
import { until } from './helpers-basic.js';

afterEach(() => vi.useRealTimers());

it('keeps waiting for an asynchronous condition and finishes once it becomes true', async () => {
  let ready = false;
  const settled = vi.fn();
  const waiting = until(async () => ready).then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  ready = true;
  await waiting;
  expect(settled).toHaveBeenCalledOnce();
});

it('waits by turns of the event loop, not by a clock: a clock that never moves does not stop it', async () => {
  vi.useFakeTimers();
  let looks = 0;
  await until(() => ++looks === 3);
  expect(looks).toBe(3);
});
