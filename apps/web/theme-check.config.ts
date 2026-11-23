/// <reference types="node" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/* The checks of a theme archive's look and world (src/themes/check.ts) as one module for node, which the server loads
   when a theme is uploaded (apps/server/src/modules/themes/web-check.ts). Everything it imports is in it; only node's own
   modules stay outside. */
export default defineConfig({
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: {
    ssr: fileURLToPath(new URL('./src/themes/check.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./dist-check', import.meta.url)),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { format: 'es', entryFileNames: 'theme-check.js' } },
  },
});
