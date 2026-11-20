/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* The screens a person who runs a department keeps, Subscriptions & API and the department's approvals, in all three
   engines, on prepared browser executables and a Vite server of this checkout: Design's rules on each, and the heights of
   their pieces compared between the engines afterwards. Workers inherit the runner's chosen port. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4600));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: ['approval-policy.spec.ts', 'subscriptions-api.spec.ts'],
  grep: /who runs/,
  outputDir: 'results/owner-screens',
  globalTeardown: './owner-screens-sizes.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  timeout: 0,
  expect: { timeout: 0 },
  use: { baseURL: origin, actionTimeout: 0, navigationTimeout: 0, reducedMotion: 'reduce', timezoneId: 'UTC', trace: { mode: 'retain-on-failure', screenshots: false } },
  projects: [
    { name: 'owner-screens-chromium', use: { browserName: 'chromium' } },
    { name: 'owner-screens-firefox', use: { browserName: 'firefox' } },
    { name: 'owner-screens-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
