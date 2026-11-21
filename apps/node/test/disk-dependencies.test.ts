import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dropDependencies } from '../src/disk/dependencies.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
/* git as the node runs it for an agent: its output, or the failure. */
const run = (args: string[], cwd: string) =>
  new Promise<string>((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fill = (path: string, bytes: number) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
};

/* A clone of a finished task with work in it that is on no remote: a change not committed and a commit not pushed. */
function finishedClone() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hh-deps-')));
  roots.push(root);
  const origin = join(root, 'origin.git'), clone = join(root, 'shop');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, clone);
  writeFileSync(join(clone, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(join(clone, 'app.js'), 'one\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-q', '-m', 'start');
  git(clone, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(clone, 'app.js'), 'one\ntwo, not committed\n');
  writeFileSync(join(clone, 'later.js'), 'committed, not pushed\n');
  git(clone, 'add', 'later.js');
  git(clone, 'commit', '-q', '-m', 'later');
  writeFileSync(join(clone, '.env'), 'KEY=made-up\n');
  return { root, clone };
}

describe("a finished task's clone, short of its dependencies", () => {
  it('loses every node_modules git ignores, at any depth, and says how much that freed', async () => {
    const { clone } = finishedClone();
    fill(join(clone, 'node_modules', 'left-pad', 'index.js'), 512 * 1024);
    fill(join(clone, 'packages', 'web', 'node_modules', 'react', 'index.js'), 512 * 1024);
    const freed = await dropDependencies(clone, run);
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    expect(existsSync(join(clone, 'packages', 'web', 'node_modules'))).toBe(false);
    expect(existsSync(join(clone, 'packages', 'web'))).toBe(true);
    expect(freed).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('keeps the work in it that is on no remote, and every other file git ignores', async () => {
    const { clone } = finishedClone();
    fill(join(clone, 'node_modules', 'left-pad', 'index.js'), 1024);
    await dropDependencies(clone, run);
    expect(readFileSync(join(clone, 'app.js'), 'utf8')).toBe('one\ntwo, not committed\n');
    expect(git(clone, 'log', '-1', '--format=%s').trim()).toBe('later');
    expect(git(clone, 'rev-list', '--count', 'HEAD', '--not', '--remotes').trim()).toBe('1');
    expect(readFileSync(join(clone, '.env'), 'utf8')).toBe('KEY=made-up\n');
  });

  it('reads a folder named as git pathspec magic as a plain name, so every other file git ignores stays', async () => {
    const { clone } = finishedClone();
    fill(join(clone, ':!a', 'node_modules', 'left-pad', 'index.js'), 1024);
    fill(join(clone, 'node_modules', 'react', 'index.js'), 1024);
    await dropDependencies(clone, run);
    expect(existsSync(join(clone, ':!a', 'node_modules'))).toBe(false);
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    expect(readFileSync(join(clone, '.env'), 'utf8')).toBe('KEY=made-up\n');
  });

  it('keeps a node_modules that git tracks', async () => {
    const { clone } = finishedClone();
    fill(join(clone, 'vendor', 'node_modules', 'kept.js'), 1024);
    git(clone, 'add', '-f', 'vendor/node_modules/kept.js');
    git(clone, 'commit', '-q', '-m', 'vendored');
    expect(await dropDependencies(clone, run)).toBe(0);
    expect(existsSync(join(clone, 'vendor', 'node_modules', 'kept.js'))).toBe(true);
  });

  it('never removes what a link named node_modules points to', async () => {
    const { root, clone } = finishedClone();
    fill(join(root, 'store', 'left-pad', 'index.js'), 1024);
    symlinkSync(join(root, 'store'), join(clone, 'node_modules'));
    writeFileSync(join(clone, '.gitignore'), 'node_modules\n.env\n');
    await dropDependencies(clone, run);
    expect(existsSync(join(root, 'store', 'left-pad', 'index.js'))).toBe(true);
  });

  it('frees nothing in a clone without dependencies', async () => {
    const { clone } = finishedClone();
    expect(await dropDependencies(clone, run)).toBe(0);
  });
});
