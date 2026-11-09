import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { reporters: ['../../packages/protocol/src/test-timings-reporter.ts', 'default'], include: ['test/**/*.test.ts'], globalSetup: ['test/global-setup.ts'], setupFiles: ['test/yaml-once.ts'], testTimeout: 20000, env: { TZ: 'UTC' } },
});
