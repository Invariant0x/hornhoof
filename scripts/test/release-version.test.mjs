import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanProjects, manifests, project, readJson, writeJson } from './project.mjs';

afterEach(cleanProjects);

for (const { current, branch, args, want } of [
  { current: '0.5.0', branch: 'turn-5', args: ['turn'], want: '0.5.0' },
  { current: '0.5.0', branch: 'task-164', args: ['turn', '7'], want: '0.7.0' },
  { current: '0.5.0', branch: 'hotfix', args: ['fix'], want: '0.5.1' },
  { current: '0.150.0', branch: 'turn-150', args: ['major'], want: '1.150.0' },
]) {
  test(`${args.join(' ')} writes ${want} to every manifest and workspace lock entry`, () => {
    const p = project(current, branch);
    const result = p.run('release-version.mjs', ...args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(p.versions(), Array(5).fill(want));
    const lock = readJson(join(p.root, 'package-lock.json'));
    assert.equal(lock.version, want);
    for (const path of manifests) assert.equal(lock.packages[path.slice(0, -'package.json'.length).replace(/\/$/, '')].version, want);
    assert.equal(lock.packages['node_modules/example-dependency'].version, '9.8.7');
  });
}

test('turn normalizes a workspace still at the old independent web version', () => {
  const p = project();
  writeJson(join(p.root, 'apps/web/package.json'), { name: '@project/web', version: '0.0.0' });
  const result = p.run('release-version.mjs', 'turn');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(p.versions(), Array(5).fill('0.5.0'));
});

for (const args of [[], ['other'], ['turn', '-1'], ['turn', '7.5'], ['turn', '07'], ['fix', '7']]) {
  test(`rejects ${JSON.stringify(args)} before changing any version`, () => {
    const p = project();
    const before = p.versions();
    const result = p.run('release-version.mjs', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage|turn number/i);
    assert.deepEqual(p.versions(), before);
  });
}

test('turn needs an explicit number outside a turn branch', () => {
  const p = project('0.5.0', 'task-164');
  const result = p.run('release-version.mjs', 'turn');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /turn-N|turn number/i);
});

test('a malformed lock fails before any manifest is rewritten', () => {
  const p = project();
  const before = manifests.map(path => readFileSync(join(p.root, path), 'utf8'));
  writeFileSync(join(p.root, 'package-lock.json'), '{invalid');
  const result = p.run('release-version.mjs', 'fix');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lock|JSON/i);
  assert.deepEqual(manifests.map(path => readFileSync(join(p.root, path), 'utf8')), before);
});

for (const key of ['', 'apps/web']) {
  test(`a missing lock entry ${key || '.'} fails before any manifest is rewritten`, () => {
    const p = project();
    const before = manifests.map(path => readFileSync(join(p.root, path), 'utf8'));
    const path = join(p.root, 'package-lock.json'), lock = readJson(path);
    delete lock.packages[key];
    writeJson(path, lock);
    const result = p.run('release-version.mjs', 'fix');
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`package-lock.json has no workspace entry: ${key || '.'}`), result.stderr);
    assert.deepEqual(manifests.map(path => readFileSync(join(p.root, path), 'utf8')), before);
  });
}
