/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const port = process.env.HORNHOOF_BROWSER_PORT ?? String(4300 + process.pid % 1000);
const origin = `http://127.0.0.1:${port}`;

/* This check uses prepared browser executables and owns a Vite server in this checkout. */
export default defineConfig({
  testDir: '.',
  testMatch: 'agent-assignment.spec.ts',
  outputDir: 'results/agent-assignment',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  use: {
    baseURL: origin,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'assignment-chromium', use: { browserName: 'chromium' } },
    { name: 'assignment-firefox', use: { browserName: 'firefox' } },
    { name: 'assignment-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    reuseExistingServer: false,
  },
});
