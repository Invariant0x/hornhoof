import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { changedBy, fingerprint, input, inventory, manifest, prepare, prints, strays, unitsOf } from './fingerprint-graph.mjs';

before(prepare);

test('a document keeps the results of all but the few tests that name it', async () => {
  strays(await changedBy('README.md'), 'protocol', 'node', 'server', 'web', 'browser', 'browser-matrix', 'release-scripts', 'mutation');
});

test('a change stays in its group: the frontend, the backend and the node leave each other alone', async () => {
  const web = await changedBy('apps/web/src/org.ts');
  strays(web, 'server', 'node', 'protocol', 'release-scripts', 'mutation');
  const server = await changedBy('apps/server/src/modules/testruns/reuse.ts');
  strays(server, 'web', 'node', 'protocol', 'release-scripts', 'mutation');
  const node = await changedBy('apps/node/src/tests.ts');
  strays(node, 'server', 'web', 'protocol', 'release-scripts', 'mutation');
  assert.ok(unitsOf('node').filter(unit => node.has(unit)).length <= unitsOf('node').length / 2, 'one file of the node should not rerun most of its tests');
});

test('a scenario follows the screen named like it, and a shared look takes every scenario but no other test', async () => {
  const changed = await changedBy('apps/web/src/screens/About.tsx');
  assert.ok(changed.has('browser:apps/web/e2e/about.spec.ts') && changed.has('browser-matrix:apps/web/e2e/about.spec.ts'));
  assert.ok(!changed.has('browser:apps/web/e2e/agent-state.spec.ts'));
  const shared = await changedBy('apps/web/src/theme.css');
  assert.deepEqual(unitsOf('browser', 'browser-matrix').filter(unit => !shared.has(unit)), []);
  strays(shared, 'server', 'node', 'protocol');
});

test('mutation of a file follows that file and the fast tests that judge it', async () => {
  const own = await changedBy('apps/node/src/redact.ts');
  assert.ok(own.has('mutation:apps/node/src/redact.ts'));
  assert.ok(!own.has('mutation:apps/server/src/auth/limit.ts'));
  assert.ok((await changedBy('apps/server/test/limit.test.ts')).has('mutation:apps/server/src/auth/limit.ts'));
  assert.ok(!(await changedBy('apps/server/src/db/schema.ts')).has('mutation:apps/server/src/auth/limit.ts'));
});

test('every risky source has a fast test to judge it and is a unit of the mutation suite', () => {
  const { sourcePaths } = manifest.mutation, suite = manifest.suites.find(item => item.id === 'mutation');
  assert.deepEqual(suite.files, sourcePaths);
  assert.deepEqual(inventory.filter(unit => unit.suiteId === 'mutation').map(unit => unit.file).sort(), [...sourcePaths].sort());
  const reached = fingerprint.fastTestsOf(input, manifest.mutation, sourcePaths);
  assert.deepEqual(sourcePaths.filter(source => !reached.get(source).length), []);
});

test('a whole inventory fits the message that carries it', async () => {
  const { UnitFingerprints } = await import('@hornhoof/protocol');
  assert.equal(prints.length, inventory.length + 1);
  assert.ok(UnitFingerprints.safeParse(prints).success);
  assert.ok(inventory.some(unit => unit.suiteId === 'browser-matrix') && inventory.some(unit => unit.suiteId === 'server-postgres'));
});
