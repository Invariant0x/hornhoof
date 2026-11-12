/// <reference types="node" />
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'src', 'theme-boot.ts');
const DEV_PATH = '/theme-boot.js';

/* src/theme-boot.ts and what it imports as one plain script with no imports of its own. The page allows only its own
   script files, so the script cannot sit inline in index.html; a plain script, unlike a module, runs where it stands. */
export async function bundleThemeBoot(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, emptyOutDir: false, minify: true, lib: { entry: ENTRY, formats: ['iife'], name: 'hornhoofThemeBoot', fileName: () => 'theme-boot.js' } },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!('output' in output)) continue;
    const chunk = output.output.find(file => file.type === 'chunk');
    if (chunk && chunk.type === 'chunk') return chunk.code;
  }
  throw new Error('theme-boot: the build gave no script');
}

/* Sets the chosen theme before the page draws: index.html gets the script first thing in its head, served by the dev
   server and written to assets/ by the build under a name that changes with what it holds. */
export function themeBoot(): Plugin {
  let command: 'serve' | 'build' = 'serve';
  let base = '/';
  let built: { fileName: string; code: string } | null = null;
  return {
    name: 'hornhoof-theme-boot',
    configResolved(config) {
      command = config.command;
      base = config.base;
    },
    configureServer(server) {
      server.middlewares.use(DEV_PATH, (_req, res, next) => {
        bundleThemeBoot().then(code => {
          res.setHeader('content-type', 'text/javascript');
          res.setHeader('cache-control', 'no-cache');
          res.end(code);
        }, next);
      });
    },
    async buildStart() {
      if (command !== 'build') return;
      const code = await bundleThemeBoot();
      built = { fileName: `assets/theme-boot-${createHash('sha256').update(code).digest('hex').slice(0, 8)}.js`, code };
    },
    generateBundle() {
      if (built) this.emitFile({ type: 'asset', fileName: built.fileName, source: built.code });
    },
    transformIndexHtml() {
      const src = command === 'build' && built ? `${base}${built.fileName}` : DEV_PATH;
      return [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }];
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), themeBoot()],
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
