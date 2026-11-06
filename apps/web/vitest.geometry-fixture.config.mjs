import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/* Explicit fixture-only authorcheck. It is not part of the default browser or web unit suites. */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['apps/web/e2e/geometry-fixture.vitest.ts'],
    environment: 'node',
    testTimeout: 60000,
    coverage: { include: ['apps/web/e2e/geometry-fixture.ts'], reporter: ['text', 'lcov'], reportsDirectory: 'coverage/geometry-wrapper' },
  },
});
