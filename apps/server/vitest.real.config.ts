import { defineConfig } from 'vitest/config';

// Port 5002, where Pebble validates, is shared, so the files never run side by side.
// These files are named .real.ts, not .test.ts: the list of tests a turn's machines run names every .test.ts of the server,
// and those machines have no Pebble and no Postgres of their own to run these against.
export default defineConfig({
  test: {
    include: ['test/real/**/*.real.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 0,
    // A test or hook here makes a database on a real server and migrates it: how long that takes is the machine's, so it has no limit.
    hookTimeout: 0,
    fileParallelism: false,
  },
});
