/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* The words of the shell's bars over the map, in a page that reads right to left and in one that reads left to right, in
   Chromium, Firefox and WebKit, on prepared browser executables and a Vite server of this checkout. Workers inherit the
   runner's chosen port instead of recomputing it from their own PID. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4800));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'banner-direction.spec.ts',
  outputDir: 'results/banner-direction',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  /* A test, its expectations, actions and navigation have no limit (0): only the run's own limit ends a hang (note #59). */
  expect: { timeout: 0 },
  use: {
    baseURL: origin,
    actionTimeout: 0,
    navigationTimeout: 0,
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
