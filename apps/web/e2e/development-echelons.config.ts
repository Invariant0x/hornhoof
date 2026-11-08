/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

process.env.HORNHOOF_BROWSER_PORT ??= String(4300 + process.pid % 1000);
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'development-echelons.spec.ts',
  outputDir: 'results/development-echelons',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./file-report.ts']] : 'list',
  use: {
    baseURL: origin,
    reducedMotion: 'reduce',
    timezoneId: 'UTC',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: browserName,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit' },
  })),
  webServer: {
    command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`,
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: origin,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
