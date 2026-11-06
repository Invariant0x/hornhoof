import { afterEach, expect, it, vi } from 'vitest';
import { until } from './helpers-basic.js';

afterEach(() => vi.useRealTimers());

it('keeps waiting for an asynchronous condition and finishes once it becomes true', async () => {
  vi.useFakeTimers();
  let ready = false;
  const settled = vi.fn();
  const waiting = until(async () => ready, 1000).then(settled);
  await vi.advanceTimersByTimeAsync(200);
  expect(settled).not.toHaveBeenCalled();
  ready = true;
  await vi.advanceTimersByTimeAsync(200);
  await waiting;
  expect(settled).toHaveBeenCalledOnce();
});

it('rejects a condition that stays false past the caller deadline', async () => {
  vi.useFakeTimers();
  const rejected = expect(until(() => false, 30)).rejects.toThrow('Timed out waiting.');
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
});
