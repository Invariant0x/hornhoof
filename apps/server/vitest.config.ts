import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // These need Docker: npm run test:real runs them against Pebble.
    exclude: [...configDefaults.exclude, 'test/real/**'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 20000,
  },
});
