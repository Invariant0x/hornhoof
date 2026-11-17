import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { changedBy, fingerprint, input, manifest, prepare, prints } from './fingerprint-graph.mjs';

before(prepare);

test('checked Markdown invalidates preparation and its real consumers', async () => {
  const preparation = 'hornhoof-preparation:.hornhoof/test-environment.json';
  for (const path of ['CHANGELOG.md', 'AGENTS.md', 'CONTRIBUTING.md', 'apps/server/test/fixtures/test-environment-python/README.md', 'apps/server/test/fixtures/test-environment-python/no-services/README.md']) {
    const changed = await changedBy(path);
    assert.ok(changed.has(preparation), `preparation missed ${path}`);
    if (path === 'AGENTS.md' || path === 'CONTRIBUTING.md') assert.ok(changed.has('server:apps/server/test/templates.test.ts'), `templates missed ${path}`);
    if (path.includes('/fixtures/')) assert.ok(changed.has('server:apps/server/test/test-environment-templates.test.ts'), `fixture reader missed ${path}`);
  }
});

test('all risky sources retain mode-bound judges at both reuse levels', async () => {
  const { mutation } = manifest, suite = manifest.suites.find(item => item.id === 'mutation');
  assert.equal(mutation.sourcePaths.length, 7);
  const judges = fingerprint.mutationJudgesOf(input, mutation, suite, mutation.sourcePaths);
  const selected = fingerprint.fastTestsOf(input, mutation, mutation.sourcePaths);
  const tests = new Set(mutation.sourcePaths.map(source => selected.get(source)[0]));
  const tracked = input.tracked.map(entry => tests.has(entry.path) ? { ...entry, mode: '100755' } : entry);
  const next = { ...input, tracked };
  const nextJudges = fingerprint.mutationJudgesOf(next, mutation, suite, mutation.sourcePaths);
  const nextPrints = await fingerprint.fingerprintUnits(next);
  for (const source of mutation.sourcePaths) {
    assert.notEqual(nextJudges.get(source), judges.get(source), `${source} lost saved judges protection`);
    const before = prints.find(unit => unit.suiteId === 'mutation' && unit.file === source).fingerprint;
    const after = nextPrints.find(unit => unit.suiteId === 'mutation' && unit.file === source).fingerprint;
    assert.notEqual(after, before, `${source} lost upper reuse protection`);
  }
});
