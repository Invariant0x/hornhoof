import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import { afterEach, expect, vi } from 'vitest';
import { leaveLight } from '../src/guard';
import { forgetOrg } from '../src/org';
import { forgetRequestDrafts } from '../src/ui/Requests';
import { keyDefaults, type DeviceKey } from '../src/owner-key-store';

/* Waits for a state look until it comes, however long a loaded machine takes to render it; only the runner's limit for a
   test ends a state that never comes. 2_147_483_647 ms is the longest delay a timer takes. Testing Library's findBy* and
   waitFor take it from its config, expect.poll from Vitest's; vi.waitFor has no config and gives up after 1 s of its own. */
const NO_LIMIT = 2_147_483_647;
configure({ asyncUtilTimeout: NO_LIMIT });
vi.setConfig({ expect: { poll: { timeout: NO_LIMIT } } });
const waitFor = vi.waitFor;
vi.waitFor = ((callback, options) => waitFor(callback, { ...(typeof options === 'number' ? {} : options), timeout: NO_LIMIT })) as typeof vi.waitFor;

/* jsdom has the element and its open property. Chromium tests exercise the modal behavior. */
Object.defineProperties(HTMLDialogElement.prototype, {
  showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
  close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
});

/* A person's key in the tests: kept in memory, made with Node's own crypto and few rounds, and gone after each test. */
const kept: { key: DeviceKey | null } = { key: null };
keyDefaults.store = { get: async () => kept.key, put: async key => void (kept.key = key), clear: async () => void (kept.key = null) };
keyDefaults.subtle = webcrypto.subtle as SubtleCrypto;
keyDefaults.iterations = 1000;

afterEach(() => {
  cleanup();
  /* Each test starts with no company known from the one before, and no answer typed in it. */
  forgetOrg();
  forgetRequestDrafts();
  kept.key = null;
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
