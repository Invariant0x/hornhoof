import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mutateSources, outcomeOf, selectedSources, testCommand } from '../mutation/run.mjs';

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
  const files = await mutateSources(['a/none.ts', 'a/some.ts'], new Map([['a/none.ts', []], ['a/some.ts', ['a/test/some.test.ts']]]), async (source, tests) => {
    ran.push([source, tests]);
    return { code: 3, output: table(1, 1, 0, 2) };
  });
  assert.deepEqual(ran, [['a/some.ts', ['a/test/some.test.ts']]]);
  assert.deepEqual(files.map(({ ms, ...file }) => file), [{ file: 'a/none.ts', status: 'failed' }, { file: 'a/some.ts', status: 'passed', note: '1 killed, 1 survived, 0 uncovered of 2 sites' }]);
  assert.ok(files.every(file => file.ms >= 0));
});
