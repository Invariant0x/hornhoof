import { defineConfig } from 'vitest/config';

// Port 5002, where Pebble validates, is shared, so the files never run side by side.
export default defineConfig({
  test: {
    include: ['test/real/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 120000,
    fileParallelism: false,
  },
});
