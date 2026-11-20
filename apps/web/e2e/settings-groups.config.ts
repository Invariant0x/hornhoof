/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* The built Settings groups on this checkout, in each browser engine. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 5200));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'settings-groups.spec.ts',
  outputDir: 'results/settings-groups',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  timeout: 0,
  expect: { timeout: 0 },
  use: { baseURL: origin, actionTimeout: 0, navigationTimeout: 0, reducedMotion: 'reduce', timezoneId: 'UTC', trace: { mode: 'retain-on-failure', screenshots: false } },
  projects: [
    { name: 'settings-chromium', use: { browserName: 'chromium' } },
    { name: 'settings-firefox', use: { browserName: 'firefox' } },
    { name: 'settings-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `npm run build && vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
