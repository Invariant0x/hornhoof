import { defineConfig } from '@playwright/test';
import assignment from './agent-assignment.config';

/* The Video production department right after setup of the Video studio kit, in each engine. */
export default defineConfig({
  ...assignment,
  testMatch: 'video-department.spec.ts',
  outputDir: 'results/video-department',
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: `video-department-${browserName}`,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit' },
  })),
});
