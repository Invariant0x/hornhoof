import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { Ticker } from '../src/modules/keeper/ticker.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('runs a round every so often, once however often it is started, and never again once stopped', async () => {
  let rounds = 0;
  const ticks = new Ticker(async () => void rounds++, 1000);
  ticks.start();
  ticks.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect(rounds).toBe(3);
  expect(ticks.stopped).toBe(false);
  ticks.stop();
  ticks.start();
  await vi.advanceTimersByTimeAsync(3000);
  expect({ rounds, stopped: ticks.stopped }).toEqual({ rounds: 3, stopped: true });
});

it('keeps no process alive', () => {
  const unref = vi.fn();
  const every = vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref } as unknown as NodeJS.Timeout);
  onTestFinished(() => every.mockRestore());
  new Ticker(async () => {}, 1000).start();
  expect(every).toHaveBeenCalledWith(expect.any(Function), 1000);
  expect(unref).toHaveBeenCalledOnce();
});
