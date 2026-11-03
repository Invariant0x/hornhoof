import { act, renderHook } from '@testing-library/react';
import { expect, it, onTestFinished, vi } from 'vitest';
import { useRework } from '../src/ui/use-rework';

const SERVER = '2026-11-03T00:00:00.000Z';

it('shows rework at its event time and expires at exactly ten minutes on the server clock', () => {
  vi.useFakeTimers();
  onTestFinished(() => { vi.useRealTimers(); });
  vi.setSystemTime('2030-01-01T00:00:00Z');
  const { result, rerender } = renderHook(() => useRework(SERVER, SERVER));
  expect(result.current).toBe(true);
  vi.setSystemTime('2040-01-01T00:00:00Z');
  rerender();
  expect(result.current).toBe(true);
  act(() => { vi.advanceTimersByTime(599_999); });
  expect(result.current).toBe(true);
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current).toBe(false);
});

it.each([null, undefined, 'invalid', '2026-11-02T23:50:00.000Z', '2026-11-03T00:00:01.000Z'])('keeps a missing, expired or future rework quiet: %s', at => {
  const { result } = renderHook(() => useRework(at, SERVER));
  expect(result.current).toBe(false);
});
