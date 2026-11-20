/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* Workers inherit the runner's chosen port instead of recomputing it from their own PID. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4760));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

/* The tracker's sections that hold nothing (#1638, Design #1633) in the three browser engines: each says so in its own block,
   apart from what is above it, only once every source of it came, and nothing moves as it loads, comes empty or comes. It
   uses prepared browser executables and owns a Vite server in this checkout. */
export default defineConfig({
  testDir: '.',
  testMatch: 'empty-sections.spec.ts',
  outputDir: 'results/empty-sections',
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
    { name: 'empty-chromium', use: { browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'empty-firefox', use: { browserName: 'firefox' } },
    { name: 'empty-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
