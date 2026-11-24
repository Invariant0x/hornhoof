import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/hook-bridge.test.ts', 'test/hook-delivery.test.ts', 'test/hook-retry-delivery.test.ts', 'test/terminal-mac-peer.test.ts', 'test/terminal-host-peer.test.ts'],
    setupFiles: ['test/fakes/no-proc.ts'],
    testTimeout: 0,
    hookTimeout: 0,
  },
});
