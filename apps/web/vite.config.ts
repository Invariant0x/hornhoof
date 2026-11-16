import react from '@vitejs/plugin-react';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';
import { linkedPackageDirs } from './linked-packages.config.js';
import { skinsBoot } from './skins-boot.config.js';

const WEB = dirname(fileURLToPath(import.meta.url));
const ROOT = searchForWorkspaceRoot(WEB);

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...skinsBoot()],
  /* ws: the agent terminal is a WebSocket under /api too. */
  server: {
    proxy: { '/api': { target: 'http://localhost:8080', ws: true } },
    /* The checkout, as Vite serves by default, and the dependencies a worktree links from its clone. */
    fs: { allow: [ROOT, ...linkedPackageDirs(WEB, ROOT)] },
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
