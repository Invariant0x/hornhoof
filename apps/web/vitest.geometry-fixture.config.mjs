import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/* Explicit geometry authorcheck. It is not part of the default browser or web unit suites. */
export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['apps/web/e2e/geometry-fixture.vitest.ts', 'apps/web/e2e/geometry-measurement.unit.mjs', 'apps/web/e2e/geometry-compare.unit.mjs'],
    environment: 'node',
    testTimeout: 60000,
    coverage: { include: ['apps/web/e2e/geometry-fixture.ts', 'apps/web/e2e/geometry-measurement.ts', 'apps/web/e2e/geometry-compare.mjs'],
      reporter: ['text', 'lcov'], reportsDirectory: 'coverage/geometry-mapped' },
  },
});
