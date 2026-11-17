/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { browserPort } from './browser-port';

process.env.HORNHOOF_BROWSER_PORT ??= String(browserPort(process.pid, 4670));
const port = process.env.HORNHOOF_BROWSER_PORT;
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.', testMatch: 'phones.spec.ts', outputDir: 'results/phones',
  forbidOnly: Boolean(process.env.CI), workers: 1, retries: 0, timeout: 180_000,
  reporter: 'list', expect: { timeout: 0 },
  use: { baseURL: origin, actionTimeout: 0, navigationTimeout: 0, reducedMotion: 'reduce', timezoneId: 'UTC', trace: 'retain-on-failure' },
  projects: [
    { name: 'phones-chromium', use: { browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'phones-firefox', use: { browserName: 'firefox' } },
    { name: 'phones-webkit', use: { browserName: 'webkit' } },
  ],
  webServer: { command: `vite --mode browser-test --host 127.0.0.1 --port ${port} --strictPort`, cwd: fileURLToPath(new URL('..', import.meta.url)), url: origin, reuseExistingServer: false },
});
