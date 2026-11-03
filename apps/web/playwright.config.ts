/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';

/* Tests in a real browser, for what jsdom cannot lay out. The app runs on Vite's dev server and every /api call is answered
   in the page by the test itself, so no Hornhoof server is needed. The browser comes from `npx playwright install
   --only-shell chromium`, or from PLAYWRIGHT_BROWSERS_PATH on a Hornhoof node, which carries the same version. */
const PORT = 4179;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } }],
  webServer: { command: `vite --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: !process.env.CI },
});
