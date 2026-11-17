import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';
import { fileURLToPath } from 'node:url';

const webServer = base.webServer;
if (!webServer || Array.isArray(webServer) || !webServer.url) throw new Error('This browser check needs one web server.');

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'hide-secret.spec.ts',
  outputDir: 'results/hide-secret',
  /* Build the current sources before the scenario starts; its runner limit covers the interaction. */
  webServer: { ...webServer, command: `npm run build && vite preview --port ${new URL(webServer.url).port} --strictPort`, cwd: fileURLToPath(new URL('..', import.meta.url)) },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
