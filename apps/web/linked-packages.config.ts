/// <reference types="node" />
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/* The real folders of the web app's dependencies that stand outside the checkout. A worktree prepared by npm run deps links
   the packages of its clone, and Vite serves no file outside the checkout, so a font such a package ships was refused with
   403. Only these folders are opened, never the clone or the disk around them; a checkout whose packages are its own opens
   nothing more. Apart from vite.config.ts, so its tests count towards coverage. */
export function linkedPackageDirs(web: string, root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const checkout = realpathSync(root);
  const dirs = Object.keys(manifest.dependencies ?? {}).flatMap(name => {
    const installed = [join(web, 'node_modules', name), join(root, 'node_modules', name)].find(path => existsSync(path));
    if (!installed) return [];
    const real = realpathSync(installed);
    return within(checkout, real) ? [] : [real];
  });
  return [...new Set(dirs)].sort();
}

function within(parent: string, path: string): boolean {
  const way = relative(parent, path);
  return way === '' || (!way.startsWith('..') && !isAbsolute(way));
}
