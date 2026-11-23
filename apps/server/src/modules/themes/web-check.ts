import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ThemeWebCheck } from '@hornhoof/protocol/themes';

/* The checks of a theme's look and world that the screens' own code holds (apps/web/src/themes/check.ts). A built server
   loads the module the web build bundles for node; tests and a server run from its sources read the sources. Both src/
   and dist/ stand at the same depth below apps/server, so one path serves either. */
const BUNDLE = fileURLToPath(new URL('../../../../web/dist-check/theme-check.js', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../../../web/src/themes/check.ts', import.meta.url));

let loaded: Promise<ThemeWebCheck> | null = null;

export function webThemeCheck(): Promise<ThemeWebCheck> {
  return (loaded ??= import(pathToFileURL(existsSync(BUNDLE) ? BUNDLE : SOURCE).href).then(module => module as ThemeWebCheck));
}
