import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Import inside each test so a missing implementation is reported as a failing test.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'quality-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'reports'));
  await writeFile(path.join(root, 'helper.ts'), 'export const value = 1;');
  const { prepareCache } = await import('./cache.mjs');
  const env = { MODE: 'test', PRIVATE_SETTING: 'synthetic-private-value' };
  const prepare = environment => prepareCache(root, environment ?? env, 'node-test');
  await prepare();
  await writeFile(path.join(root, 'reports/incremental.json'), 'cached');
  return { root, prepare };
}

test('unchanged inputs preserve the incremental report', async t => {
  const { root, prepare } = await fixture(t);
  assert.equal(await prepare(), false);
  assert.equal(await readFile(path.join(root, 'reports/incremental.json'), 'utf8'), 'cached');
});

for (const name of ['helper.ts', 'vitest.config.mjs', 'package-lock.json', 'src/new-helper.ts']) {
  test(`changing ${name} invalidates previous results`, async t => {
    const { root, prepare } = await fixture(t);
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'changed');
    assert.equal(await prepare(), true);
    await assert.rejects(readFile(path.join(root, 'reports/incremental.json')), { code: 'ENOENT' });
  });
}

test('a removed helper invalidates previous results', async t => {
  const { root, prepare } = await fixture(t);
  await rm(path.join(root, 'helper.ts'));
  assert.equal(await prepare(), true);
});

test('environment changes invalidate results without persisting private values', async t => {
  const { root, prepare } = await fixture(t);
  assert.equal(await prepare({ MODE: 'other', PRIVATE_SETTING: 'another-synthetic-value' }), true);
  const stamp = await readFile(path.join(root, 'reports/fingerprint'), 'utf8');
  assert.match(stamp, /^[a-f0-9]{64}\n$/);
});
