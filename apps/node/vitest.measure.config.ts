import { defineConfig } from 'vitest/config';

/* The harness measurement on a real repository, which no test run starts: it installs and builds for minutes. */
export default defineConfig({ test: { include: ['test/harness.measure.ts'], testTimeout: 1_800_000, reporters: ['default'] } });
