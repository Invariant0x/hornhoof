import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgedAgain, keepJudges, mutateSources, mutatorArgs, outcomeOf, selectedSources, testCommand } from '../mutation/run.mjs';

const table = (killed, survived, uncovered, sites) => `name   ns  killed survived uncovered sites score\n-----\nfoo    a        ${killed}        ${survived}          ${uncovered}     ${sites}  50.0%\n-----\nTotal         ${killed}        ${survived}          ${uncovered}     ${sites}  50.0%\n\n`;

test('a survivor is a finding the note carries, not a failure', () => {
  assert.deepEqual(outcomeOf(3, table(2, 7, 0, 9)), { status: 'passed', note: '2 killed, 7 survived, 0 uncovered of 9 sites' });
  assert.deepEqual(outcomeOf(0, table(9, 0, 0, 9)), { status: 'passed', note: '9 killed, 0 survived, 0 uncovered of 9 sites' });
});

for (const [why, code, output] of [
  ['the tests fail unmutated', 2, table(0, 0, 0, 9)],
  ['the command is wrong', 1, ''],
  ['the tool could not start', null, ''],
  ['it found no source and still exits 0', 0, 'No source files to mutate.\n'],
  ['the file has nothing to mutate', 0, table(0, 0, 0, 0)],
]) {
  test(`a file fails when ${why}`, () => assert.deepEqual(outcomeOf(code, output), { status: 'failed' }));
}

test('the fast tests of each package run from that package', () => {
  assert.equal(testCommand(['apps/node/test/a.test.ts', 'apps/node/test/deep/b.test.ts']), 'npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/node test/a.test.ts test/deep/b.test.ts');
  assert.equal(testCommand(['apps/node/test/a.test.ts', 'apps/server/test/b.test.ts']), 'npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/node test/a.test.ts && npx --no-install vitest run --config ../../scripts/mutation/vitest.config.mjs --root apps/server test/b.test.ts');
});

test('a path reaches the shell as one word', () => {
  assert.match(testCommand(["apps/node/test/a b;'c.test.ts"]), /--root apps\/node 'test\/a b;'\\''c\.test\.ts'$/);
});

test('a run takes what it was given, and everything when run by hand', () => {
  const mutation = { sourcePaths: ['a/one.ts', 'a/two.ts'] };
  assert.deepEqual(selectedSources('["./a/two.ts"]', mutation), ['a/two.ts']);
  assert.deepEqual(selectedSources(undefined, mutation), ['a/one.ts', 'a/two.ts']);
});

test('a source no fast test reaches fails without running, and the others still run', async () => {
  const ran = [];
  const files = await mutateSources(['a/none.ts', 'a/some.ts'], new Map([['a/none.ts', []], ['a/some.ts', ['a/test/some.test.ts']]]), {
    testsPass: async () => true,
    mutate: async (source, tests) => {
      ran.push([source, tests]);
      return { code: 3, output: table(1, 1, 0, 2) };
    },
  });
  assert.deepEqual(ran, [['a/some.ts', ['a/test/some.test.ts']]]);
  assert.ok(files.every(file => file.ms >= 0));
  assert.deepEqual(files.map(file => ({ ...file, ms: 0 })), [{ file: 'a/none.ts', status: 'failed', ms: 0 }, { file: 'a/some.ts', status: 'passed', note: '1 killed, 1 survived, 0 uncovered of 2 sites', ms: 0 }]);
});

test('a source whose tests fail unmutated fails without mutating: from its snapshot the tool would call every mutant killed', async () => {
  const ran = [];
  const files = await mutateSources(['a/red.ts', 'a/green.ts'], new Map([['a/red.ts', ['a/test/red.test.ts']], ['a/green.ts', ['a/test/green.test.ts']]]), {
    testsPass: async tests => tests[0] === 'a/test/green.test.ts',
    mutate: async source => {
      ran.push(source);
      return { code: 0, output: table(1, 0, 0, 1) };
    },
  });
  assert.deepEqual(ran, ['a/green.ts']);
  assert.deepEqual(files.map(file => [file.file, file.status]), [['a/red.ts', 'failed'], ['a/green.ts', 'passed']]);
});

test('what the tool runs says to mutate everything only when asked', () => {
  assert.ok(!mutatorArgs('a/one.ts', ['a/test/one.test.ts'], false).includes('--mutate-all'));
  assert.ok(mutatorArgs('a/one.ts', ['a/test/one.test.ts'], true).includes('--mutate-all'));
  assert.deepEqual(mutatorArgs('a/one.ts', ['a/test/one.test.ts'], false).slice(0, 4), ['--root', '.', '--source-root', 'a/one.ts']);
});

test('a source is judged again by tests that changed, and keeps what it was judged by only once it went well', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'hh-judges-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = 'apps/a/src/one.ts', oids = oid => new Map([['apps/a/test/one.test.ts', oid]]), tests = ['apps/a/test/one.test.ts'];
  assert.equal(judgedAgain(folder, source, tests, oids('1')), true);
  keepJudges(folder, source, tests, oids('1'));
  assert.equal(judgedAgain(folder, source, tests, oids('1')), false);
  assert.equal(judgedAgain(folder, source, tests, oids('2')), true);
  assert.equal(judgedAgain(folder, source, [...tests, 'apps/a/test/two.test.ts'], oids('1')), true);
  assert.equal(judgedAgain(folder, 'apps/a/src/two.ts', tests, oids('1')), true);
});

/* Run the real cache/runner with tiny command stand-ins. No mutants or database are needed to observe --mutate-all. */
for (const changed of ['helper', 'config', 'mode', 'source', 'unknown']) {
  test(`saved mutation judges invalidate ${changed} changes without editing the test`, t => {
    const folder = mkdtempSync(join(tmpdir(), 'hh-mutation-judges-'));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const root = join(folder, 'repo'), bin = join(folder, 'bin'), calls = join(folder, 'calls');
    mkdirSync(root); mkdirSync(bin);
    const write = (path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const source = 'apps/a/src/one.ts', helper = 'apps/a/test/helper.ts', config = 'scripts/mutation/vitest.config.mjs';
    const mutation = { status: 'supported', tool: join(bin, 'mutator'), sourcePaths: [source], fastTestPaths: ['apps/a/test/one.test.ts'] };
    write('.hornhoof/test-environment.json', JSON.stringify({ mutation, dependencies: { inputs: [], install: [] }, prepare: [], suites: [{ id: 'a', root: 'apps/a' }, { id: 'mutation', root: 'scripts/mutation' }] }));
    write('package.json', '{}');
    write(source, 'export const one = 1;');
    write('apps/a/test/one.test.ts', "import { one } from '../src/one.js';\nimport './helper.js';\nexport { one };");
    write(helper, changed === 'unknown' ? "const name = './unknown.js';\nawait import(name);" : "import './deep.js';");
    write('apps/a/test/deep.ts', 'export const allowed = true;');
    write(config, "import './config-helper.mjs';\nexport default {};");
    write('scripts/mutation/config-helper.mjs', 'export const strict = true;');
    writeFileSync(join(bin, 'npx'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(bin, 'mutator'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf 'Total 1 0 0 1 100.0%%\\n'\n`, { mode: 0o755 });
    git('init', '--quiet'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test'); git('add', '.'); git('commit', '--quiet', '-m', 'First');
    const run = () => {
      execFileSync(process.execPath, [fileURLToPath(new URL('../mutation/run.mjs', import.meta.url))], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HH_TEST_FILES: '', HH_TEST_REPORT: '' }, stdio: 'pipe' });
      return readFileSync(calls, 'utf8').trim().split('\n').at(-1).includes('--mutate-all');
    };
    assert.equal(run(), true);
    assert.equal(run(), false, 'unchanged judges retain the saved snapshot');
    if (changed === 'helper') write('apps/a/test/deep.ts', 'export const allowed = false;');
    if (changed === 'config') write('scripts/mutation/config-helper.mjs', 'export const strict = false;');
    if (changed === 'source') write(source, 'export const one = 2;');
    if (changed === 'mode') chmodSync(join(root, helper), 0o755);
    if (changed === 'unknown') write('apps/a/test/unknown.ts', 'export const skipped = true;');
    git('add', '.'); git('commit', '--quiet', '-m', 'Judges changed');
    assert.equal(run(), true, `${changed} invalidates the persisted judges receipt`);
  });
}
