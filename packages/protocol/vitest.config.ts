import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { reporters: ['./src/test-timings-reporter.ts', 'default'], exclude: ['**/node_modules/**', 'test/.timings-*/**'] },
});
