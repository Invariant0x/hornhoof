/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* All product tables (Machines, Backlog, People) in the three browser engines on prepared browser executables and a Vite
   server of this checkout: 44px touch targets on SortTable headers and row buttons, focus rings, RTL and cross-engine size
   parity within 1px. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4680));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'sort-tables.spec.ts',
  outputDir: 'results/sort-tables',
  globalTeardown: './sort-tables-sizes.ts',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  timeout: 0,
  expect: { timeout: 0 },
  use: { baseURL: origin, actionTimeout: 0, navigationTimeout: 0, reducedMotion: 'reduce', timezoneId: 'UTC', trace: { mode: 'retain-on-failure', screenshots: false } },
  projects: [
    { name: 'sort-tables-chromium', use: { browserName: 'chromium' } },
    { name: 'sort-tables-firefox', use: { browserName: 'firefox' } },
    { name: 'sort-tables-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
