import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChannels, type Way } from '../src/ui/channels';

describe('the ways messages went', () => {
  afterEach(() => vi.useRealTimers());

  it('go quiet ten minutes after the last message, however often the page fetches them again', () => {
    vi.useFakeTimers();
    const first: Way<string>[] = [{ key: 'a', at: new Date().toISOString(), value: 'a' }];
    const { result, rerender } = renderHook(({ seed }) => useChannels(seed), { initialProps: { seed: first } });
    expect(result.current.live).toEqual(['a']);
    act(() => vi.advanceTimersByTime(5 * 60_000));
    /* The page fetches the company again, and the server still names the same message. */
    rerender({ seed: first.map(w => ({ ...w })) });
    expect(result.current.live).toEqual(['a']);
    act(() => vi.advanceTimersByTime(5 * 60_000 + 1));
    expect(result.current.live).toEqual([]);
  });
});
