import { defineConfig } from 'vitest/config';
import server from './vitest.config.js';

// The slow tests run whole programs end to end: real git and builds in processes of their own, the installer many times
// over, a fresh server loaded through tsx. Their files are named .slow.ts, not .test.ts, so the list of every change's
// tests leaves them out, and they run in the final and full runs of a release candidate, with the server's own setup and
// no wall-clock limit on a test or a hook.
export default defineConfig({
  test: {
    ...server.test,
    include: ['test/slow/**/*.slow.ts'],
    passWithNoTests: false,
    testTimeout: 0,
    hookTimeout: 0,
  },
});
