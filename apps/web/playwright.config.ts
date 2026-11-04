/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';

/* Tests in a real browser, for what jsdom cannot lay out. The app runs on Vite's dev server and every /api call is answered
   in the page by the test itself, so no Hornhoof server is needed. The browser comes from `npx playwright install chromium`
   on a developer's machine, or from PLAYWRIGHT_BROWSERS_PATH (/data/browsers) prepared on a Hornhoof node at the lockfile version. */
const PORT = process.env.HORNHOOF_BROWSER_PORT ?? '4179';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  /* Match UTC clock fixtures regardless of the host timezone. */
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', timezoneId: 'UTC' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } }],
  /* A browser check owns its server; another checkout can have different code or live edits. */
  webServer: { command: `vite --mode browser-test --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false },
});
