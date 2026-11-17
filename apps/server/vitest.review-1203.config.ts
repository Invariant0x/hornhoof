import { defineConfig } from 'vitest/config';

/* Pure admission-state checks do not open the server or a database. */
export default defineConfig({ test: { include: ['apps/server/test/program-room-review.test.ts'], testTimeout: 20000 } });
