/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* The room a wide screen keeps under the top bar and beside the open card, in the three engines, with prepared browser
   executables, on a Vite server of this checkout. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4500));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: ['desktop-room.spec.ts'],
  outputDir: 'results/desktop-room',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 0,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  /* A test, its expectations, actions and navigation have no limit (0): only the run's own limit ends a hang (note #59). */
  expect: { timeout: 0 },
  use: {
    baseURL: origin,
    actionTimeout: 0,
    navigationTimeout: 0,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'room-chromium', use: { browserName: 'chromium' } },
    { name: 'room-firefox', use: { browserName: 'firefox' } },
    { name: 'room-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
