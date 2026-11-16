import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { searchForWorkspaceRoot, type UserConfig } from 'vite';
import config from '../vite.config';
import { linkedPackageDirs } from '../linked-packages.config';

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function folder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-linked-')));
  made.push(dir);
  return dir;
}
function put(path: string, text = '') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function link(path: string, target: string) {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'dir');
}
/* A checkout with the web app's manifest naming these dependencies. */
function checkout(dependencies: string[]): { root: string; web: string } {
  const root = folder(), web = join(root, 'apps', 'web');
  put(join(web, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(dependencies.map(name => [name, '1.0.0'])), devDependencies: { 'dev-only': '1.0.0' } }));
  return { root, web };
}

describe('the packages of the web app that a worktree links from its clone', () => {
  it('opens the real folder of each linked dependency, and nothing else of the clone', () => {
    const clone = folder();
    put(join(clone, 'node_modules', '@fontsource', 'onest', 'files', 'onest-latin-400-normal.woff2'));
    put(join(clone, 'node_modules', 'dev-only', 'index.js'));
    put(join(clone, 'node_modules', 'not-named', 'index.js'));
    const { root, web } = checkout(['@fontsource/onest', 'react']);
    link(join(root, 'node_modules', '@fontsource', 'onest'), join(clone, 'node_modules', '@fontsource', 'onest'));
    link(join(root, 'node_modules', 'dev-only'), join(clone, 'node_modules', 'dev-only'));
    link(join(root, 'node_modules', 'not-named'), join(clone, 'node_modules', 'not-named'));
    put(join(root, 'node_modules', 'react', 'index.js'));

    expect(linkedPackageDirs(web, root)).toEqual([join(clone, 'node_modules', '@fontsource', 'onest')]);
  });

  it('opens nothing more in a checkout whose packages are its own', () => {
    const { root, web } = checkout(['@fontsource/onest', 'react']);
    put(join(root, 'node_modules', '@fontsource', 'onest', 'index.css'));
    put(join(root, 'node_modules', 'react', 'index.js'));
    expect(linkedPackageDirs(web, root)).toEqual([]);
  });

  it('opens nothing for a package linked inside the checkout or not installed at all', () => {
    const { root, web } = checkout(['@hornhoof/protocol', 'missing']);
    put(join(root, 'packages', 'protocol', 'package.json'), '{}');
    link(join(root, 'node_modules', '@hornhoof', 'protocol'), join(root, 'packages', 'protocol'));
    expect(linkedPackageDirs(web, root)).toEqual([]);
  });

  it("takes the web app's own installed copy before the root's", () => {
    const clone = folder();
    put(join(clone, 'node_modules', '@fontsource', 'tektur', 'index.css'));
    const { root, web } = checkout(['@fontsource/tektur']);
    put(join(web, 'node_modules', '@fontsource', 'tektur', 'index.css'));
    link(join(root, 'node_modules', '@fontsource', 'tektur'), join(clone, 'node_modules', '@fontsource', 'tektur'));
    expect(linkedPackageDirs(web, root)).toEqual([]);
  });
});

describe("the files Vite serves to the page", () => {
  it('are those of the checkout, and of the dependencies a worktree links from its clone', async () => {
    const web = join(__dirname, '..');
    const root = searchForWorkspaceRoot(web);
    const resolved = (await (config as (env: { mode: string; command: 'serve' | 'build' }) => UserConfig | Promise<UserConfig>)({ mode: 'browser-test', command: 'serve' }));
    expect(resolved.server?.fs?.allow).toEqual([root, ...linkedPackageDirs(web, root)]);
  });
});
