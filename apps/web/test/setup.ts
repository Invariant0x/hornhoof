import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

afterEach(() => {
  cleanup();
  /* Timer tests keep their fake clock until cleanup has checked the resources they owned. */
  const timers = vi.isFakeTimers() ? vi.getTimerCount() : 0;
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  expect(timers, 'Timers left after component cleanup').toBe(0);
});
