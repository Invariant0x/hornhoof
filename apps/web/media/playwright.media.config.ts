/// <reference types="node" />
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

/* Renders the README pictures and animations from Moonfern and Oak Lane home with the real web app. Kept in its own
   folder and config so normal unit and browser test runs never pick these scenes up. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..');
const PORT = process.env.HORNHOOF_MEDIA_PORT ?? '4180';

export default defineConfig({
  testDir: path.join(HERE, 'scenes'),
  outputDir: path.join(HERE, 'results'),
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'en',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    video: {
      mode: 'on',
      size: { width: 1440, height: 900 },
    },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        channel: process.env.PLAYWRIGHT_CHANNEL,
      },
    },
    ...(['firefox', 'webkit'] as const).map(browserName => ({
      name: browserName,
      grep: /tracker screenshots/,
      testMatch: ['**/tasks.spec.ts', '**/board.spec.ts', '**/turns.spec.ts'],
      use: { browserName, video: 'off' as const },
    })),
  ],
  webServer: {
    command: `npx vite --mode browser-test --port ${PORT} --strictPort`,
    cwd: WEB_ROOT,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
