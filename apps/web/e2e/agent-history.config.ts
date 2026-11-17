import { defineConfig } from '@playwright/test';
import assignment from './agent-assignment.config';

export default defineConfig({
  ...assignment,
  testMatch: 'agent-history.spec.ts',
  outputDir: 'results/agent-history',
  projects: ['chromium', 'firefox', 'webkit'].map(browserName => ({
    name: `history-${browserName}`,
    use: { browserName: browserName as 'chromium' | 'firefox' | 'webkit' },
  })),
});
