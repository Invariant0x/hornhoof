import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    maxWorkers: 1,
    coverage: { provider: 'v8', reporter: ['lcov'], include: ['src/redact.ts'] },
  },
});
