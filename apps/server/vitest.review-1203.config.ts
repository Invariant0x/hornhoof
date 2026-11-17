import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/* Pure admission-state checks do not open the server or a database. */
export default defineConfig({ root: fileURLToPath(new URL('.', import.meta.url)), test: { include: ['test/program-room-review.test.ts'], testTimeout: 20000 } });
