import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  /* ws: the agent terminal is a WebSocket under /api too. */
  server: { proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  test: {
    environment: 'jsdom',
    /* UTC fixtures keep exact clock assertions independent of the host timezone. */
    env: { TZ: 'UTC' },
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 20000,
  },
});
