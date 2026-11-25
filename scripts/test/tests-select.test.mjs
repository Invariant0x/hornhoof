import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { LOOK_BACK, provedBase } from '../github-tests/base.mjs';
import { changesSince } from '../github-tests/changes.mjs';
import { FILES_PER_PART, LINT_FILES, PARTS, invocationsOf, lintCommands, outputsOf, partsOf, planOf, runAll } from '../github-tests/parts.mjs';
import { setAside } from '../release/workspace-versions.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const ZERO = '0'.repeat(40);

/* The selector reads the manifest with the built protocol: a checkout that has not built it yet builds it here, as a part's
   preparation would. */
async function protocol() {
  if (!existsSync(join(root, 'packages/protocol/dist/index.js'))) execFileSync('npm', ['run', '-s', 'build', '-w', '@hornhoof/protocol'], { cwd: root, stdio: 'inherit' });
  return import('@hornhoof/protocol');
}

function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-tests-select-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* A repository with main, and a way to add a commit to whatever is checked out. */
function repository(t) {
  const dir = folder(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--quiet', '--initial-branch=main');
  let count = 0;
  const commit = () => {
    count += 1;
    writeFileSync(join(dir, `f${count}.txt`), `${count}\n`);
    git('add', '.');
    git('commit', '--quiet', '-m', `c${count}`);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

/* GitHub's marks: the commits whose tests passed. */
const passed = (...shas) => async sha => shas.includes(sha);

test('a push stands on the tip it moved, when that tip passed', async t => {
  const { git, commit } = repository(t);
  commit();
  const before = commit(), sha = commit();
  const found = await provedBase({ name: 'push', event: { before }, sha }, { git, proved: passed(before) });
  assert.equal(found.base, before, found.why);
});

test('a full run stands on no commit, whatever an earlier commit has for a mark: every test runs (B1)', async t => {
  const { git, commit } = repository(t);
  commit();
  const before = commit(), sha = commit();
  let asked = 0;
  const forged = async () => { asked += 1; return true; };
  for (const [name, event] of [['push', { before }], ['pull_request', { pull_request: { base: { sha: before } } }], ['workflow_dispatch', {}]]) {
    const found = await provedBase({ name, event, sha, full: true }, { git, proved: forged });
    assert.equal(found.base, null, `${name}: ${found.why}`);
    assert.match(found.why, /full run/);
  }
  assert.equal(asked, 0, 'a full run reads no mark');
  const narrowed = await provedBase({ name: 'push', event: { before }, sha, full: false }, { git, proved: forged });
  assert.equal(narrowed.base, before, 'without the input the same event stands on the commit before it');
});

test('a push stands on the nearest commit before that tip that passed, as a push of texts alone leaves no mark', async t => {
  const { git, commit } = repository(t);
  const marked = commit(), before = commit(), sha = commit();
  const found = await provedBase({ name: 'push', event: { before }, sha }, { git, proved: passed(marked) });
  assert.equal(found.base, marked, found.why);
});

test(`a push looks back no further than ${LOOK_BACK} commits, and without a passed one there runs the whole suite`, async t => {
  const { git, commit } = repository(t);
  const marked = commit();
  let before;
  for (let i = 0; i < LOOK_BACK; i += 1) before = commit();
  const sha = commit();
  const found = await provedBase({ name: 'push', event: { before }, sha }, { git, proved: passed(marked) });
  assert.equal(found.base, null);
  assert.match(found.why, /passed/);
});

test('a push that starts a branch, or whose tip before is not in the checkout, runs the whole suite', async t => {
  const { git, commit } = repository(t);
  const sha = commit();
  for (const before of [ZERO, 'e'.repeat(40), undefined]) {
    const found = await provedBase({ name: 'push', event: { before }, sha }, { git, proved: passed(sha) });
    assert.equal(found.base, null, String(before));
  }
});

test('a run by hand stands on where its branch left main, not on where main is now', async t => {
  const { git, commit } = repository(t);
  commit();
  const left = commit();
  git('checkout', '--quiet', '-b', 'turn-8');
  commit();
  const sha = commit();
  git('checkout', '--quiet', 'main');
  const moved = commit();
  git('update-ref', 'refs/remotes/origin/main', moved);
  git('checkout', '--quiet', sha);
  const found = await provedBase({ name: 'workflow_dispatch', event: {}, sha }, { git, proved: passed(left, moved) });
  assert.equal(found.base, left, found.why);
});

test('a run by hand of main itself stands on the commit before it that passed, never on itself', async t => {
  const { git, commit } = repository(t);
  const marked = commit(), sha = commit();
  git('update-ref', 'refs/remotes/origin/main', sha);
  const found = await provedBase({ name: 'workflow_dispatch', event: {}, sha }, { git, proved: passed(marked) });
  assert.equal(found.base, marked, found.why);
});

test('a pull request stands on its base', async t => {
  const { git, commit } = repository(t);
  const base = commit(), sha = commit();
  const found = await provedBase({ name: 'pull_request', event: { pull_request: { base: { sha: base } } }, sha }, { git, proved: passed(base) });
  assert.equal(found.base, base, found.why);
});

test('any other event, or a GitHub that cannot say which commit passed, runs the whole suite', async t => {
  const { git, commit } = repository(t);
  const before = commit(), sha = commit();
  assert.equal((await provedBase({ name: 'schedule', event: { before }, sha }, { git, proved: passed(before) })).base, null);
  const found = await provedBase({ name: 'push', event: { before }, sha }, { git, proved: async () => { throw new Error('GitHub answered 502'); } });
  assert.equal(found.base, null);
  assert.match(found.why, /502/);
});

const unit = (suiteId, file) => ({ suiteId, file, selectionUnit: file });
const pick = (packageId, mode, files) => ({ packageId, mode, units: files.map(file => unit(packageId, file)), reasons: [] });
const serverFiles = count => Array.from({ length: count }, (_, i) => `apps/server/test/t${String(i).padStart(3, '0')}.test.ts`);

test('a small selection runs in one part', () => {
  assert.deepEqual(partsOf({ packages: [pick('server', 'related', ['apps/server/test/a.test.ts']), pick('release-scripts', 'whole-package', ['scripts/test/b.test.mjs'])], notes: [] }),
    [{ server: ['apps/server/test/a.test.ts'], 'release-scripts': ['scripts/test/b.test.mjs'] }]);
});

test(`a larger one takes a part for each ${FILES_PER_PART} files, ${PARTS} at most, every file in exactly one`, () => {
  for (const [count, parts] of [[FILES_PER_PART, 1], [FILES_PER_PART + 1, 2], [FILES_PER_PART * 3, 3], [FILES_PER_PART * 10, PARTS]]) {
    const files = serverFiles(count);
    const found = partsOf({ packages: [pick('server', 'related', files)], notes: [] });
    assert.equal(found.length, parts, String(count));
    assert.deepEqual(found.flatMap(part => part.server).sort(), files);
    const sizes = found.map(part => part.server.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, sizes.join(' '));
  }
});

test('a change that reaches no test still runs the checks, in one part', () => {
  assert.deepEqual(partsOf({ packages: [], notes: ['document without tests: README.md'] }), [{}]);
});

test('the plan lints the files the change left, one eslint for each workspace', () => {
  const base = 'b'.repeat(40);
  const changes = [
    { kind: 'modified', path: 'apps/server/src/a.ts' }, { kind: 'added', path: 'apps/server/test/a.test.ts' }, { kind: 'deleted', path: 'apps/server/src/gone.ts' },
    { kind: 'renamed', previousPath: 'apps/web/src/old.tsx', path: 'apps/web/src/New.tsx' }, { kind: 'modified', path: 'scripts/tests-mark.mjs' },
    { kind: 'modified', path: 'README.md' }, { kind: 'modified', path: 'tool.config.mjs' },
  ];
  const suites = [{ id: 'server', root: 'apps/server' }, { id: 'web', root: 'apps/web' }, { id: 'release-scripts', root: 'scripts' }];
  const plan = planOf(base, changes, { packages: [pick('server', 'related', ['apps/server/test/a.test.ts'])], notes: [] }, suites);
  assert.deepEqual(plan, { base, lint: [['apps/server/src/a.ts', 'apps/server/test/a.test.ts'], ['apps/web/src/New.tsx'], ['scripts/tests-mark.mjs'], ['tool.config.mjs']], parts: [{ server: ['apps/server/test/a.test.ts'] }] });
});

test('a wide change is linted in several runs of one workspace, each small enough for the memory a run has', () => {
  const changes = Array.from({ length: 2 * LINT_FILES + 50 }, (_, i) => ({ kind: 'modified', path: `apps/server/src/f${i}.ts` }));
  const plan = planOf('b'.repeat(40), [...changes, { kind: 'modified', path: 'apps/web/src/a.tsx' }], { packages: [], notes: [] }, [{ id: 'server', root: 'apps/server' }, { id: 'web', root: 'apps/web' }]);
  assert.deepEqual(plan.lint.map(files => files.length), [LINT_FILES, LINT_FILES, 50, 1]);
  assert.deepEqual(plan.lint.flat(), [...changes.map(change => change.path), 'apps/web/src/a.tsx']);
});

test('the outputs give the parts to run, the selection and its base, or the whole suite in four parts', () => {
  const plan = { base: 'b'.repeat(40), lint: [], parts: [{ server: ['apps/server/test/a.test.ts'] }, { web: ['apps/web/test/b.test.ts'] }] };
  assert.equal(outputsOf(plan), `parts=[1,2]\nselection=${JSON.stringify(plan)}\nbase=${plan.base}\n`);
  assert.equal(outputsOf(null), 'parts=[1,2,3,4]\nselection=\nbase=\n');
});

test('the lint is the whole lint without a selection, and the files of the change with one', () => {
  assert.deepEqual(lintCommands(null), [{ program: 'npm', args: ['run', 'lint'], cwd: '.' }]);
  assert.deepEqual(lintCommands({ lint: [['apps/server/src/a.ts'], ['scripts/x.mjs']] }), [
    { program: 'npx', args: ['--no-install', 'eslint', 'apps/server/src/a.ts'], cwd: '.' },
    { program: 'npx', args: ['--no-install', 'eslint', 'scripts/x.mjs'], cwd: '.' },
  ]);
  assert.deepEqual(lintCommands({ lint: [] }), []);
});

test('a part runs each suite as a node runs it, with its own files, and Vitest with two workers', async t => {
  const dir = folder(t);
  const { parseTestEnvironment } = await protocol();
  const manifest = parseTestEnvironment(readFileSync(join(root, '.hornhoof/test-environment.json'), 'utf8'));
  const built = [];
  const build = async (suite, files, context) => { built.push({ id: suite.id, files, context }); return { command: { ...suite.run, args: [...suite.run.args, 'built'] }, env: { MARK: suite.id } }; };
  const found = await invocationsOf({ server: ['apps/server/test/a.test.ts'], 'release-scripts': ['scripts/test/b.test.mjs'] }, manifest.suites, { root, dir }, build);
  const server = manifest.suites.find(suite => suite.id === 'server'), scripts = manifest.suites.find(suite => suite.id === 'release-scripts');
  assert.deepEqual(found, [
    { command: { ...server.run, args: [...server.run.args, 'built', '--maxWorkers=2'] }, env: { MARK: 'server' } },
    { command: { ...scripts.run, args: [...scripts.run.args, 'built'] }, env: { MARK: 'release-scripts' } },
  ]);
  assert.deepEqual(built.map(item => [item.id, item.files, item.context]), [
    ['server', ['apps/server/test/a.test.ts'], { checkout: root, filesPath: join(dir, 'files-server.json'), shard: { index: 1, count: 1 } }],
    ['release-scripts', ['scripts/test/b.test.mjs'], { checkout: root, filesPath: join(dir, 'files-release-scripts.json'), shard: { index: 1, count: 1 } }],
  ]);
});

test('every command of a part runs even when one before it failed, and the part fails then', async () => {
  const ran = [];
  const exec = async command => { ran.push(command.program); return command.program === 'bad' ? 1 : 0; };
  assert.equal(await runAll([{ command: { program: 'bad', args: [], cwd: '.' }, env: {} }, { command: { program: 'good', args: [], cwd: '.' }, env: {} }], exec), 1);
  assert.deepEqual(ran, ['bad', 'good']);
  assert.equal(await runAll([{ command: { program: 'good', args: [], cwd: '.' }, env: {} }], exec), 0);
  assert.equal(await runAll([], exec), 0);
});

/* Package files as a release finds them: the root's, a workspace's and the lockfile, each at the version given. */
function packageFiles(version, change = files => files) {
  const root = { name: 'shop', version, workspaces: ['apps/*'], engines: { node: '>=22' }, devDependencies: { eslint: '^10.0.0' } };
  const app = { name: '@shop/api', version, dependencies: { zod: '^4.0.0' } };
  const lock = {
    name: 'shop', version, lockfileVersion: 3, requires: true,
    packages: {
      '': { name: 'shop', version, workspaces: ['apps/*'], devDependencies: { eslint: '^10.0.0' } },
      'apps/api': { name: '@shop/api', version, dependencies: { zod: '^4.0.0' } },
      'node_modules/@shop/api': { resolved: 'apps/api', link: true },
      'node_modules/zod': { version: '4.0.0' },
    },
  };
  return change({ 'package.json': root, 'apps/api/package.json': app, 'package-lock.json': lock });
}

function writeFiles(dir, files) {
  for (const [path, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  }
}

/* A repository whose every commit holds exactly the package files given, so a diff from its first commit is what they change. */
function packageRepository(t) {
  const { dir, git } = repository(t);
  const commit = files => {
    git('rm', '--quiet', '-r', '--ignore-unmatch', '.');
    writeFiles(dir, files);
    git('add', '.');
    git('commit', '--quiet', '--allow-empty', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };
  return { git, commit, base: commit(packageFiles('1.0.0')) };
}

test('a release, which moves only our own versions in the package files and the lockfile, changes nothing the tests choose by', async t => {
  const { git, commit, base } = packageRepository(t);
  const sha = commit(packageFiles('1.1.0'));
  assert.deepEqual(changesSince(base, sha, git), { changes: [], moved: ['apps/api/package.json', 'package-lock.json', 'package.json'] });
});

test('any other change of a package file still counts, with a version that moved or without', async t => {
  const { git, commit, base } = packageRepository(t);
  const other = {
    'an engine': files => { files['package.json'].engines.node = '>=24'; return files; },
    'a dependency of a workspace': files => { files['apps/api/package.json'].dependencies.ms = '^2.1.3'; return files; },
    'a script': files => { files['package.json'].scripts = { test: 'node --test' }; return files; },
    'a version the lockfile holds of a dependency': files => { files['package-lock.json'].packages['node_modules/zod'].version = '4.0.1'; return files; },
    'the name of a workspace': files => { files['apps/api/package.json'].name = '@shop/core'; return files; },
  };
  for (const [what, change] of Object.entries(other)) {
    for (const version of ['1.0.0', '1.1.0']) {
      const touched = Object.keys(change(packageFiles('1.0.0'))).filter(path => JSON.stringify(change(packageFiles('1.0.0'))[path]) !== JSON.stringify(packageFiles('1.0.0')[path]));
      const found = changesSince(base, commit(packageFiles(version, change)), git);
      for (const path of touched) assert.ok(found.changes.some(item => item.path === path), `${what} at ${version}: ${path}`);
      assert.ok(!found.moved.some(path => touched.includes(path)), what);
    }
  }
});

test('a package file that is not ours, as a fixture, or one that came or went, counts even when only a version differs', async t => {
  const { git, commit, base } = packageRepository(t);
  const fixture = { name: 'fixture', version: '1.0.0' };
  const withFixture = commit({ ...packageFiles('1.0.0'), 'apps/api/test/fixture/package.json': fixture });
  const sha = commit({ ...packageFiles('1.0.0'), 'apps/api/test/fixture/package.json': { ...fixture, version: '2.0.0' } });
  assert.deepEqual(changesSince(withFixture, sha, git), { changes: [{ kind: 'modified', path: 'apps/api/test/fixture/package.json' }], moved: [] });
  const added = commit({ ...packageFiles('1.0.0'), 'apps/web/package.json': { name: '@shop/web', version: '1.0.0' } });
  assert.deepEqual(changesSince(base, added, git).changes, [{ kind: 'added', path: 'apps/web/package.json' }]);
});

test('a package file that cannot be read as JSON counts as changed', async t => {
  const { git, commit, base } = packageRepository(t);
  const sha = commit({ ...packageFiles('1.0.0'), 'apps/api/package.json': '{ "name": "@shop/api",' });
  assert.deepEqual(changesSince(base, sha, git).changes, [{ kind: 'modified', path: 'apps/api/package.json' }]);
});

test('the Docker builds install from package files with our own versions set aside, the same for every release', t => {
  const set = version => {
    const dir = folder(t);
    writeFiles(dir, packageFiles(version));
    setAside(dir);
    return Object.fromEntries(Object.keys(packageFiles(version)).map(path => [path, readFileSync(join(dir, path), 'utf8')]));
  };
  const one = set('1.0.0'), two = set('1.1.0');
  assert.deepEqual(one, two);
  const lock = JSON.parse(one['package-lock.json']);
  assert.deepEqual([lock.version, lock.packages[''].version, lock.packages['apps/api'].version, JSON.parse(one['package.json']).version, JSON.parse(one['apps/api/package.json']).version], Array(5).fill('0.0.0'));
  assert.equal(lock.packages['node_modules/zod'].version, '4.0.0');
  assert.deepEqual(JSON.parse(one['package.json']), { ...packageFiles('0.0.0')['package.json'] });
});
