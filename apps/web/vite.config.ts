import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  /* ws: the agent terminal is a WebSocket under /api too. */
  server: {
    proxy: { '/api': { target: 'http://localhost:8080', ws: true } },
    /* Source edits in another check must not remount the page during a browser gesture. */
    watch: mode === 'browser-test' ? null : undefined,
  },
  test: {
    reporters: ['../../packages/protocol/src/test-timings-reporter.ts', 'default'],
    environment: 'jsdom',
    /* UTC fixtures keep exact clock assertions independent of the host timezone. */
    env: { TZ: 'UTC' },
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 20000,
  },
}));
