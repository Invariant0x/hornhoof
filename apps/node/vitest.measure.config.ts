import { defineConfig } from 'vitest/config';

/* The measurements on real repositories, which no test run starts: they install and build for minutes. */
export default defineConfig({ test: { include: ['test/*.measure.ts'], setupFiles: ['test/measure-setup.ts'], testTimeout: 0, hookTimeout: 0, reporters: ['default'] } });
