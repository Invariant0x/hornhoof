/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';

const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error('This browser check needs one web server.');

/* The forms with secrets in the three engines (#1320): e2e/login-autofill.spec.ts. Chromium alone also keeps a real saved
   login there. It owns a Vite server in this checkout, on the port the base config settled on. */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'login-autofill.spec.ts',
  outputDir: 'results/login-autofill',
  webServer: { ...webServer, cwd: fileURLToPath(new URL('..', import.meta.url)) },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
