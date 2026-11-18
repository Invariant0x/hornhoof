import { defineConfig } from '@playwright/test';
import assignment from './agent-assignment.config';

/* The named task wait in each engine: Firefox showed the page ending its own stream as a failed request there (#1337). */
export default defineConfig({
  ...assignment,
  testMatch: 'task-wait.spec.ts',
  outputDir: 'results/task-wait',
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: `task-wait-${browserName}`,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit' },
  })),
});
