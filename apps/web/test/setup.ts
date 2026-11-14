import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';
import { leaveLight } from '../src/guard';
import { forgetOrg } from '../src/org';
import { forgetRequestDrafts } from '../src/ui/Requests';

/* Waits for a state look until it comes, however long a loaded machine takes to render it; only the runner's limit for a
   test ends a state that never comes. 2_147_483_647 ms is the longest delay a timer takes. Testing Library's findBy* and
   waitFor take it from its config, expect.poll from Vitest's; vi.waitFor has no config and gives up after 1 s of its own. */
const NO_LIMIT = 2_147_483_647;
configure({ asyncUtilTimeout: NO_LIMIT });
vi.setConfig({ expect: { poll: { timeout: NO_LIMIT } } });
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) => waitFor(callback, { ...(typeof options === 'number' ? {} : options), timeout: NO_LIMIT })) as typeof vi.waitFor;

afterEach(() => {
  cleanup();
  /* Each test starts with no company known from the one before, and no answer typed in it. */
  forgetOrg();
  forgetRequestDrafts();
  /* A test that tripped the guard leaves the page with its effects on for the next one. */
  leaveLight();
  /* Timer tests keep their fake clock until cleanup has checked the resources they owned. */
  const timers = vi.isFakeTimers() ? vi.getTimerCount() : 0;
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
  expect(timers, 'Timers left after component cleanup').toBe(0);
});
