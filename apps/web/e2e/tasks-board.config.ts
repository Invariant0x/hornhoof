/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

/* The tracker in the three engines, with prepared browser executables, on a Vite server of this checkout. */
process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4400));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: ['tasks-board/tasks-board.spec.ts', 'task-panel.spec.ts'],
  outputDir: 'results/tasks-board',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 180_000,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  /* An expectation that does not come true fails in 15 seconds, not at the test's limit; actions and navigation have no
     limit of their own (0), so the limit for a test above bounds them. */
  expect: { timeout: 15_000 },
  use: {
    baseURL: origin,
    actionTimeout: 0,
    navigationTimeout: 0,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'tasks-chromium', use: { browserName: 'chromium' } },
    { name: 'tasks-firefox', use: { browserName: 'firefox' } },
    { name: 'tasks-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
