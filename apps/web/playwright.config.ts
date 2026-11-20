/// <reference types="node" />
import { defineConfig, devices } from '@playwright/test';
import { browserPort } from './e2e/browser-port';

/* Tests in a real browser, for what jsdom cannot lay out. The app runs on Vite's dev server and every /api call is answered
   in the page by the test itself, so no Hornhoof server is needed. The browser comes from `npx playwright install chromium`
   on a developer's machine, or from PLAYWRIGHT_BROWSERS_PATH (/data/browsers) prepared on a Hornhoof node at the lockfile version. */
/* A part of a test run shares its machine with other parts; its workers read the port the runner settled on from the environment. */
process.env.HORNHOOF_BROWSER_PORT ??= process.env.HH_TEST_REPORT ? String(browserPort(process.pid)) : '4179';
const PORT = process.env.HORNHOOF_BROWSER_PORT;
/* What the run of a release leaves to the full run: every look but English, light and wide. Without --project every test runs once, as ever. */
const MATRIX = /\b(?:ru|dark|375(?:px)?)\b/;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: process.env.HH_TEST_REPORT ? [['list'], ['./e2e/file-report.ts']] : 'list',
  /* A test, an expectation, an action or a navigation goes on until its state comes, however loaded the machine is: 0 is no
     limit (note #59). Only the run's own limit ends a state that never comes. */
  timeout: 0,
  expect: { timeout: 0 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    actionTimeout: 0,
    navigationTimeout: 0,
    /* Without a GPU every frame is drawn on the CPU, so a page kept rendering takes a whole core from the tests around it, idle
       or not. Running animations and a trace's screenshots each keep it rendering. A failure still keeps the trace's DOM
       snapshots, and e2e/motion.spec.ts asks for motion where it checks motion. */
    reducedMotion: 'reduce',
    trace: { mode: 'retain-on-failure', screenshots: false },
    /* Match UTC clock fixtures regardless of the host timezone. */
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'chromium', grepInvert: MATRIX, use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } },
    { name: 'matrix', grep: MATRIX, use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL } },
  ],
  /* A browser check owns its server; another checkout can have different code or live edits. */
  webServer: { command: `vite --mode browser-test --port ${PORT} --strictPort`, url: `http://localhost:${PORT}`, reuseExistingServer: false },
});
