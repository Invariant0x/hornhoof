/// <reference types="node" />
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type HtmlTagDescriptor, type Plugin } from 'vite';

/* How the script that sets the theme before the page draws is built and put first in index.html. Apart from
   vite.config.ts, so its tests count towards coverage. */
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
  const chunk = [result].flat().flatMap(output => ('output' in output ? output.output : [])).find(file => file.type === 'chunk');
  if (chunk?.type !== 'chunk') throw new Error('theme-boot: the build gave no script');
  return chunk.code;
}

const bootTag = (src: string): HtmlTagDescriptor[] => [{ tag: 'script', attrs: { src }, injectTo: 'head-prepend' }];

function sendScript(res: ServerResponse, code: string): void {
  res.setHeader('content-type', 'text/javascript');
  res.setHeader('cache-control', 'no-cache');
  res.end(code);
}

/* The dev server builds the script each time the page asks for it, so a change shows on the next load. */
const devThemeBoot = (): Plugin => ({
  name: 'hornhoof-theme-boot-dev',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use(DEV_PATH, (_req, res, next) => void bundleThemeBoot().then(code => sendScript(res, code), next));
  },
  transformIndexHtml: () => bootTag(DEV_PATH),
});

/* The build writes it to assets/ under a name that changes with what it holds, so it is cached for as long as it lasts. */
function buildThemeBoot(): Plugin {
  let base = '/';
  let built = { fileName: '', code: '' };
  return {
    name: 'hornhoof-theme-boot-build',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    async buildStart() {
      const code = await bundleThemeBoot();
      built = { fileName: `assets/theme-boot-${createHash('sha256').update(code).digest('hex').slice(0, 8)}.js`, code };
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: built.fileName, source: built.code });
    },
    transformIndexHtml: () => bootTag(`${base}${built.fileName}`),
  };
}

/* Sets the chosen theme before the page draws: index.html gets the script first thing in its head. */
export const themeBoot = (): Plugin[] => [devThemeBoot(), buildThemeBoot()];
