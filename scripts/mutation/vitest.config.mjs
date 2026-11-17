import { fileURLToPath, URL } from 'node:url';
import CountsReporter from './counts-reporter.mjs';

/* Use the same pinned protocol source as the product run, without database or reporter setup. A built copy may belong
   to another candidate, and must not decide whether a mutation's unmodified baseline masks a secret. The alias is the
   product config's, written here rather than imported from it, so a mutation still follows only its own file and the
   fast tests that judge it. The mutation tool reads only counts, the same with or without an AI agent; a baseline of
   run.mjs asks for Vitest's full report on the command line. */
const source = fileURLToPath(new URL('../../packages/protocol/src/', import.meta.url));
const alias = [
  { find: /^@hornhoof\/protocol$/, replacement: source + 'index.ts' },
  { find: /^@hornhoof\/protocol\/(.+)$/, replacement: source + '$1.ts' },
];
export default { test: { alias, include: ['test/**/*.test.ts'], env: { TZ: 'UTC' }, reporters: [new CountsReporter()] } };
