/// <reference types="node" />
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/* An isolated real server serves the built source under test. This config never starts the mocked Vite fixtures. */
export default defineConfig({
  ...base,
  testMatch: 'geometry.spec.ts',
  testIgnore: [],
  outputDir: 'e2e/results/geometry',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e/results/geometry/playwright.json' }]],
  use: {
    ...base.use,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  },
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: browserName,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit', channel: undefined, deviceScaleFactor: 1 },
  })),
  webServer: undefined,
});
