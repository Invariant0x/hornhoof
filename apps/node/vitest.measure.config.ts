import { defineConfig } from 'vitest/config';

/* The measurements on real repositories, which no test run starts: they install and build for minutes. */
export default defineConfig({ test: { include: ['test/*.measure.ts'], setupFiles: ['test/measure-setup.ts'], testTimeout: 1_800_000, reporters: ['default'] } });
