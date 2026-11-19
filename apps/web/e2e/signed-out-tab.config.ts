/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';

const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error('This browser check needs one web server.');

/* A tab whose session ended goes to log in, and a signed-out tab reloads to a new build, in the three engines (#1592):
   e2e/signed-out-tab.spec.ts. It owns a Vite server in this checkout, on the port the base config settled on. */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'signed-out-tab.spec.ts',
  outputDir: 'results/signed-out-tab',
  webServer: { ...webServer, cwd: fileURLToPath(new URL('..', import.meta.url)) },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
