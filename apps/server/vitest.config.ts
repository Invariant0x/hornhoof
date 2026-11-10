import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The tests under test/real need Docker: npm run test:real runs them against Pebble and a real Postgres.
  test: { reporters: ['../../packages/protocol/src/test-timings-reporter.ts', 'default'], include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, 'test/real/**'], globalSetup: ['test/global-setup.ts'], setupFiles: ['test/yaml-once.ts'], testTimeout: 20000, env: { TZ: 'UTC' } },
});
