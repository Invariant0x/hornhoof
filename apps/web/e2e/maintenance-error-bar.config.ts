/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* The bars of the shell during an update, in all three engines, on prepared browser executables and a Vite server of this
   checkout. Workers inherit the runner's chosen port instead of recomputing it from their PID. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4500));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'maintenance-error-bar.spec.ts',
  outputDir: 'results/maintenance-error-bar',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  /* The spec says itself that a test has no limit; expectations, actions and navigation have none either (0). */
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
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
    { name: 'bars-chromium', use: { browserName: 'chromium' } },
    { name: 'bars-firefox', use: { browserName: 'firefox' } },
    { name: 'bars-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
