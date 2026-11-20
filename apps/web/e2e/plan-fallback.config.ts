/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* A plan's fallback plans on the Subscriptions screen and an employee's card on a fallback plan, in all three engines, on
   prepared browser executables and a Vite server of this checkout. Workers inherit the runner's chosen port. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4600));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'plan-fallback.spec.ts',
  outputDir: 'results/plan-fallback',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  timeout: 0,
  expect: { timeout: 0 },
  use: { baseURL: origin, actionTimeout: 0, navigationTimeout: 0, reducedMotion: 'reduce', timezoneId: 'UTC', trace: { mode: 'retain-on-failure', screenshots: false } },
  projects: [
    { name: 'plan-fallback-chromium', use: { browserName: 'chromium' } },
    { name: 'plan-fallback-firefox', use: { browserName: 'firefox' } },
    { name: 'plan-fallback-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
