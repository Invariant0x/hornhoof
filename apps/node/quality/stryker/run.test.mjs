import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { counts, prepare, run } from './run.mjs';

test('a real command returns its output, exit code and elapsed time', () => {
  const result = run(process.execPath, ['-e', 'process.stdout.write("observed")']);
  assert.equal(result.exit, 0);
  assert.equal(result.output, 'observed');
  assert.ok(result.seconds > 0);
});

test('unexpected exits stop the pilot while survivor exits can be accepted', () => {
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(1)']), /exited 1/);
  const result = run(process.execPath, ['-e', 'process.exit(3)'], undefined, [0, 3]);
  assert.equal(result.exit, 3);
});

test('a missing executable stops the pilot', () => {
  assert.throws(() => run('/nonexistent/quality-pilot-command', []), { code: 'ENOENT' });
});

test('outcome counts retain separate compilation and timeout buckets', () => {
  assert.deepEqual(counts(['Killed', 'Survived', 'Killed', 'CompileError', 'Timeout', 'NoCoverage']), {
    Killed: 2, Survived: 1, CompileError: 1, Timeout: 1, NoCoverage: 1,
  });
});

test('both runners receive the same source and existing tests from the repository', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'quality-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = path.join(root, 'apps/node');
  for (const directory of ['src', 'test']) await mkdir(path.join(node, directory), { recursive: true });
  await writeFile(path.join(node, 'src/redact.ts'), 'export const value = 1;');
  await writeFile(path.join(node, 'test/redact.test.ts'), 'test("existing", () => {});');
  const pilot = path.join(root, 'pilot');
  await prepare(pilot, root);
  assert.equal(await readFile(path.join(pilot, 'src/redact.ts'), 'utf8'), 'export const value = 1;');
  assert.equal(await readFile(path.join(pilot, 'test/redact.test.ts'), 'utf8'), 'test("existing", () => {});');
});
