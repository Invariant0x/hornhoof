import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { reporters: ['../../packages/protocol/src/test-timings-reporter.ts', 'default'], include: ['test/**/*.test.ts'], testTimeout: 20000 },
});
