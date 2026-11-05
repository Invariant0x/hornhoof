/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';

/* Tests in a real browser, for what jsdom cannot lay out. The app runs on Vite's dev server and every /api call is answered
   in the page by the test itself, so no Hornhoof server is needed. The browser comes from `npx playwright install chromium`
   on a developer's machine, or from PLAYWRIGHT_BROWSERS_PATH (/data/browsers) prepared on a Hornhoof node at the lockfile version. */
const PORT = process.env.HORNHOOF_BROWSER_PORT ?? '4179';

export default defineConfig({
  testDir: 'e2e',
  /* The real-server geometry harness has its own config and requires pinned source/resource inputs. */
  testIgnore: 'geometry.spec.ts',
  outputDir: 'e2e/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    /* Without a GPU every frame is drawn on the CPU, so a page kept rendering takes a whole core from the tests around it, idle
       or not. Running animations and a trace's screenshots each keep it rendering. A failure still keeps the trace's DOM
       snapshots, and e2e/motion.spec.ts asks for motion where it checks motion. */
    reducedMotion: 'reduce',
    trace: { mode: 'retain-on-failure', screenshots: false },
    /* Match UTC clock fixtures regardless of the host timezone. */
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], browserName: 'chromium', channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], browserName: 'firefox' } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], browserName: 'webkit' } },
  ],
  /* A browser check owns its server; another checkout can have different code or live edits. */
  webServer: { command: `vite --mode browser-test --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false },
});
