import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/* The real last step of the root's test script, on two workspaces that write down the arguments they got in place of the
   whole suite. npm takes what follows it for its own settings unless the script hands it on past a `--` of its own. */
function runningRootTest(t, ...args) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-root-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lastStep = scripts.test.split('&&').at(-1).trim();
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true, workspaces: ['one', 'two'], scripts: { test: lastStep } }));
  for (const name of ['one', 'two']) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'seen.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync('seen.json', JSON.stringify(process.argv.slice(2)));\n`);
    writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name, scripts: { test: 'node seen.mjs' } }));
  }
  const result = spawnSync('npm', ['test', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return ['one', 'two'].map(name => JSON.parse(readFileSync(join(dir, name, 'seen.json'), 'utf8')));
}

test('a test timeout given at the root reaches the test runner of every package', t => {
  assert.deepEqual(runningRootTest(t, '--', '--testTimeout=1234'), [['--testTimeout=1234'], ['--testTimeout=1234']]);
});

test('the root runs every package with no arguments when given none', t => {
  assert.deepEqual(runningRootTest(t), [[], []]);
});
