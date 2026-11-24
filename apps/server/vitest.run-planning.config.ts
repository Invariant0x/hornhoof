import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/* Separate CLI acceptance: requires a prepared fixture-local pytest runtime. Not an ordinary server unit suite. */
export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  test: { include: ['test/test-run-invocations.cli.ts', 'test/planned-vitest-sequencer.test.ts'], environment: 'node', pool: 'forks', testTimeout: 0, hookTimeout: 0 },
});
