/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* A department's own outbound setup, in Settings and on the department's screen, in all three engines, on prepared browser
   executables and a Vite server of this checkout. Workers inherit the runner's chosen port. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4500));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'outbound-setup.spec.ts',
  outputDir: 'results/outbound-setup',
  globalTeardown: './outbound-setup-edges.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  expect: { timeout: 0 },
  use: { baseURL: origin, actionTimeout: 0, navigationTimeout: 0, reducedMotion: 'reduce', timezoneId: 'UTC', trace: { mode: 'retain-on-failure', screenshots: false } },
  projects: [
    { name: 'outbound-setup-chromium', use: { browserName: 'chromium' } },
    { name: 'outbound-setup-firefox', use: { browserName: 'firefox' } },
    { name: 'outbound-setup-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
