import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'node-build.sh');
/* Git as the tests run it, without the settings of the person who runs them, such as signed commits. */
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/* What the node image copies from the repository: the sources of each COPY that takes nothing from another stage, its
   last word being where they go. */
const copied = readFileSync(join(ROOT, 'apps', 'node', 'Dockerfile'), 'utf8')
  .split('\n')
  .filter(line => line.startsWith('COPY ') && !line.includes('--from='))
  .flatMap(line => line.split(/\s+/).slice(1).filter(word => !word.startsWith('--')).slice(0, -1))
  .map(source => source.replace(/\/$/, ''));

/* A repository of its own with the script in it, where each change is one commit. */
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-node-build-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: GIT_ENV }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@hornhoof.test');
  git('config', 'user.name', 'Test');
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(SCRIPT, join(dir, 'scripts', 'node-build.sh'));
  copyFileSync(join(ROOT, '.dockerignore'), join(dir, '.dockerignore'));
  /* One commit that changes this file alone, or a file in this folder, as a folder of the repository is one. */
  const change = (path: string) => {
    const file = statSync(join(ROOT, path), { throwIfNoEntry: false })?.isDirectory() ? join(path, 'file') : path;
    mkdirSync(join(dir, dirname(file)), { recursive: true });
    writeFileSync(join(dir, file), `${Date.now()} ${Math.random()}\n`);
    git('add', '--', file);
    git('commit', '-q', '-m', `Change ${file}`);
    return git('rev-parse', 'HEAD');
  };
  const build = () => spawnSync('bash', [join(dir, 'scripts', 'node-build.sh')], { cwd: tmpdir(), encoding: 'utf8' });
  git('add', 'scripts', '.dockerignore');
  git('commit', '-q', '-m', 'The script');
  return { dir, git, change, build };
}

describe('the node build', () => {
  it("reads what the node image copies from the node's Dockerfile", () => {
    expect(copied).toEqual(expect.arrayContaining(['package.json', 'package-lock.json', 'tsconfig.base.json', 'packages/protocol', 'apps/node']));
  });

  it('is the last commit that changed a file the node image is made of, and not a later one of the server or the web alone', () => {
    const { change, build } = repository();
    const node = change('apps/node/src/main.ts');
    change('apps/server/src/app.ts');
    change('apps/web/src/main.tsx');
    change('README.md');
    expect(build()).toMatchObject({ status: 0, stdout: `${node}\n` });
  });

  it('moves with each file the node image copies from the repository, and with what Docker leaves out of it', () => {
    const { change, build } = repository();
    for (const path of [...copied, '.dockerignore']) {
      const commit = change(path);
      expect({ path, ...build() }).toMatchObject({ path, status: 0, stdout: `${commit}\n` });
    }
  });

  it('does not move with a file Docker leaves out of the node image, such as a test of the node or the protocol', () => {
    const { change, build } = repository();
    const node = change('apps/node/src/main.ts');
    change('apps/node/test/main.test.ts');
    change('packages/protocol/test/index.test.ts');
    expect(build()).toMatchObject({ status: 0, stdout: `${node}\n` });
  });

  it('leaves out what each line of .dockerignore leaves out, read as Docker reads it', () => {
    const { dir, git, change, build } = repository();
    /* A blank line, spaces around a pattern, a * that stays in its folder, a leading and a trailing slash, and a last
       line with no end. */
    writeFileSync(join(dir, '.dockerignore'), '**/test\n\n  apps/node/*.md  \n/apps/node/fixtures/\n**/*.tmp/');
    git('commit', '-q', '-am', 'Leave out more');
    const kept = change('apps/node/docs/guide.md');
    for (const path of ['apps/node/test/main.test.ts', 'apps/node/README.md', 'apps/node/fixtures/a.json', 'packages/protocol/src/x.tmp']) change(path);
    expect(build()).toMatchObject({ status: 0, stdout: `${kept}\n` });
  });

  it('refuses an exception in .dockerignore, which brings back a file it would leave out', () => {
    const { dir, git, build } = repository();
    writeFileSync(join(dir, '.dockerignore'), '**/test\n!apps/node/test/fixtures\n');
    git('commit', '-q', '-am', 'Bring the fixtures back');
    const res = build();
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('!apps/node/test/fixtures');
  });

  it('refuses a shallow clone, where the one commit there seems to change every file', () => {
    const { dir, change } = repository();
    change('apps/node/src/main.ts');
    change('apps/server/src/app.ts');
    const shallow = mkdtempSync(join(tmpdir(), 'hh-node-build-shallow-'));
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow], { env: GIT_ENV });
    const res = spawnSync('bash', [join(shallow, 'scripts', 'node-build.sh')], { encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('fetch-depth: 0');
  });
});
