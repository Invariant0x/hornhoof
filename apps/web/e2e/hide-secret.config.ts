import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'hide-secret.spec.ts',
  outputDir: 'results/hide-secret',
  webServer: { ...base.webServer, cwd: fileURLToPath(new URL('..', import.meta.url)) },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
