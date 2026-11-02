import type { WorkLine } from '@hornhoof/protocol/map';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useWorkLines } from '../src/ui/work-lines';

const T = Date.parse('2026-11-02T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();
const line = (l: Partial<WorkLine> = {}): WorkLine => ({ upstreamAgentId: 'o', downstreamAgentId: 'h', working: false, workEpoch: 1, returnedEpoch: null, returnedAt: null, ...l });

describe('the lines of work', () => {
  afterEach(() => vi.useRealTimers());

  it('are blue while the work goes on, and quiet without work or a result', () => {
    vi.useFakeTimers({ now: T });
    const { result } = renderHook(() => useWorkLines([line({ working: true }), line({ downstreamAgentId: 'x' })], at(T)));
    expect(result.current('o', 'h')).toBe('blue');
    expect(result.current('o', 'x')).toBe('quiet');
    expect(result.current('o', 'nobody')).toBe('quiet');
  });

  it("burn yellow for what is left of five minutes after a result, on the server's clock however wrong this one is", () => {
    /* This computer's clock is an hour ahead of the server's, and the page opens two minutes after the result. */
    vi.useFakeTimers({ now: T + 3_600_000 });
    const { result } = renderHook(() => useWorkLines([line({ workEpoch: 3, returnedEpoch: 3, returnedAt: at(T - 2 * 60_000) })], at(T)));
    expect(result.current('o', 'h')).toBe('yellow');
    act(() => vi.advanceTimersByTime(3 * 60_000 - 1));
    expect(result.current('o', 'h')).toBe('yellow');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current('o', 'h')).toBe('quiet');
  });

  it("go out five minutes after the result by the time that passed, when this computer's clock is put back while the map is open", () => {
    /* The page opens two minutes after the result; a minute later the clock goes two minutes back. */
    vi.useFakeTimers({ now: T });
    const { result } = renderHook(() => useWorkLines([line({ workEpoch: 3, returnedEpoch: 3, returnedAt: at(T - 2 * 60_000) })], at(T)));
    act(() => vi.advanceTimersByTime(60_000));
    vi.setSystemTime(T - 60_000);
    act(() => vi.advanceTimersByTime(2 * 60_000 - 1));
    expect(result.current('o', 'h')).toBe('yellow');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current('o', 'h')).toBe('quiet');
  });

  it("burn the rest of the five minutes when this computer's clock is put forward while the map is open", () => {
    vi.useFakeTimers({ now: T });
    const { result, rerender } = renderHook(() => useWorkLines([line({ workEpoch: 3, returnedEpoch: 3, returnedAt: at(T - 2 * 60_000) })], at(T)));
    act(() => vi.advanceTimersByTime(60_000));
    vi.setSystemTime(T + 60 * 60_000);
    /* The map draws again for something else. */
    rerender();
    expect(result.current('o', 'h')).toBe('yellow');
    act(() => vi.advanceTimersByTime(2 * 60_000 - 1));
    rerender();
    expect(result.current('o', 'h')).toBe('yellow');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current('o', 'h')).toBe('quiet');
  });

  it('start the five minutes again with a newer result, and stay quiet for an old one once new work began', () => {
    vi.useFakeTimers({ now: T });
    const { result, rerender } = renderHook(({ lines, now }) => useWorkLines(lines, now), {
      initialProps: { lines: [line({ workEpoch: 2, returnedEpoch: 2, returnedAt: at(T - 4 * 60_000) })], now: at(T) },
    });
    expect(result.current('o', 'h')).toBe('yellow');
    act(() => vi.advanceTimersByTime(30_000));
    /* Another result came back just now: five minutes from it. */
    rerender({ lines: [line({ workEpoch: 2, returnedEpoch: 2, returnedAt: at(T + 30_000) })], now: at(T + 30_000) });
    act(() => vi.advanceTimersByTime(4 * 60_000));
    expect(result.current('o', 'h')).toBe('yellow');
    /* New work began after it, and ended without a result. */
    rerender({ lines: [line({ workEpoch: 3, returnedEpoch: 2, returnedAt: at(T + 30_000) })], now: at(T + 4.5 * 60_000) });
    expect(result.current('o', 'h')).toBe('quiet');
    /* While work goes on the line is blue, whatever came back before. */
    rerender({ lines: [line({ working: true, workEpoch: 4, returnedEpoch: 4, returnedAt: at(T + 4.5 * 60_000) })], now: at(T + 4.5 * 60_000) });
    expect(result.current('o', 'h')).toBe('blue');
  });
});
