import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = fileURLToPath(new URL('./packages/protocol/src/', import.meta.url));
const alias = [
  { find: /^@hornhoof\/protocol$/, replacement: source + 'index.ts' },
  { find: /^@hornhoof\/protocol\/(.+)$/, replacement: source + '$1.ts' },
];
const cwdSetup = fileURLToPath(new URL('./scripts/test/workspace-cwd.mjs', import.meta.url));

/* Extend the real workspace configs, including their environment, setup and existing test inventory. */
/** @param {string} name @param {string} folder @param {string} [config] @returns {import('vitest/config').TestProjectConfiguration} */
function workspace(name, folder, config = 'vitest.config.ts') {
  const root = fileURLToPath(new URL(folder + '/', import.meta.url));
  return {
    extends: fileURLToPath(new URL(folder + '/' + config, import.meta.url)), root,
    test: { name, alias, pool: 'forks', setupFiles: [cwdSetup], provide: { workspaceRoot: root } },
  };
}

export default defineConfig({
  test: {
    reporters: ['./packages/protocol/src/test-timings-reporter.ts', 'default'],
    projects: [
      workspace('@hornhoof/server', './apps/server'),
      workspace('@hornhoof/node', './apps/node'),
      workspace('@hornhoof/web', './apps/web', 'vite.config.ts'),
      workspace('@hornhoof/protocol', './packages/protocol'),
      workspace('@hornhoof/node:no-proc', './apps/node', 'vitest.no-proc.config.ts'),
    ],
  },
});
