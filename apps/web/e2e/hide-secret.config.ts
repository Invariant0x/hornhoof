import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';
import { fileURLToPath } from 'node:url';

const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error('This browser check needs one web server.');

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'hide-secret.spec.ts',
  outputDir: 'results/hide-secret',
  webServer: { ...webServer, cwd: fileURLToPath(new URL('..', import.meta.url)) },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
