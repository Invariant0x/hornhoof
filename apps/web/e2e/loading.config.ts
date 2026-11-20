/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* Workers inherit the runner's chosen port instead of recomputing it from their own PID. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4760));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

/* A screen while its data comes, once it came, when a load failed and past its one limit, in the three browser engines:
   the shared indicator stands where the data will be, nothing already shown moves, and Try again loads again. It uses
   prepared browser executables and owns a Vite server in this checkout. */
export default defineConfig({
  testDir: '.',
  testMatch: 'loading.spec.ts',
  outputDir: 'results/loading',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  /* An expectation waits at most this long; actions and navigation have no limit of their own (0). */
  expect: { timeout: 15_000 },
  use: {
    baseURL: origin,
    actionTimeout: 0,
    navigationTimeout: 0,
    reducedMotion: 'no-preference',
    timezoneId: 'UTC',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'loading-chromium', use: { browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'loading-firefox', use: { browserName: 'firefox' } },
    { name: 'loading-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
