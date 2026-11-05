import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['test/postgres/**/*.pg.spec.ts'],
    passWithNoTests: false,
    testTimeout: 20000,
  },
});
