import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { changedBy, fingerprint, input, inventory, manifest, prepare, prints, strays, unitsOf } from './fingerprint-graph.mjs';

before(prepare);

test('a document keeps the results of all but the few tests that name it', async () => {
  strays(await changedBy('README.md'), 'protocol', 'node', 'server', 'web', 'browser', 'browser-matrix', 'release-scripts', 'mutation');
});

test('a change stays in its group: the frontend, the backend and the node leave each other alone', async () => {
  const web = await changedBy('apps/web/src/org.ts');
  assert.ok(web.has('web:apps/web/test/org.test.tsx'));
  strays(web, 'server', 'node', 'protocol', 'release-scripts', 'mutation');
  const server = await changedBy('apps/server/src/modules/testruns/reuse.ts');
  strays(server, 'web', 'node', 'protocol', 'release-scripts', 'mutation');
  const node = await changedBy('apps/node/src/tests.ts');
  strays(node, 'server', 'web', 'protocol', 'release-scripts', 'mutation');
  assert.ok(unitsOf('node').filter(unit => node.has(unit)).length <= unitsOf('node').length / 2, 'one file of the node should not rerun most of its tests');
});

test('the Git mirror and the node author runner leave the driver in the pinned checkout', () => {
  const graph = fingerprint.testGraph(input);
  const mirror = graph.closure('apps/node/src/test-mirror.ts');
  assert.ok(mirror.has('apps/node/src/author-patch.ts'));
  assert.ok(!mirror.has('scripts/author-check.mjs'));
  assert.ok(!mirror.has('scripts/author-check/select.mjs'));
  const author = graph.closure('apps/node/src/author-check.ts');
  assert.ok(author.has('apps/node/src/test-mirror.ts'));
  assert.ok(!author.has('scripts/author-check.mjs'));
  assert.ok(!author.has('scripts/author-check/select.mjs'));
  assert.ok(graph.closure('scripts/test/author-check.test.mjs').has('scripts/author-check/select.mjs'));
});

/* The painter, as the SQL parser, loaded its package in its worker by a name the graph cannot read, so a test that reached it took
   the whole server and ran again for any test of the server changed. */
test('a test of the painter keeps its result when another test of the server changes', async () => {
  assert.ok(!(await changedBy('apps/server/test/agent-switch.test.ts')).has('server:apps/server/test/program-operator-painter.test.ts'));
});

/* The tests of test runs describe a product of their own, whose test folder was named test/ as the server's own is: the graph read
   each of its patterns as every test of the server. */
test('a test of test runs reads no test of the server by the patterns of the product it makes up', () => {
  const graph = fingerprint.testGraph(input);
  for (const test of ['test-runs.test.ts', 'test-run-file-results.test.ts', 'test-run-preparation.test.ts', 'test-run-machine-pace.test.ts']) {
    assert.ok(!graph.closure(`apps/server/test/${test}`).has('apps/server/test/agent-switch.test.ts'), test);
  }
});

/* A scenario opens the app and drives it, so whatever screen the app may show on the way can break it: the department screen
   once read a route the scenarios' mock did not answer, and six scenarios of other names failed. */
test('a scenario follows every screen of the app, and a screen takes every scenario but no test of another group', async () => {
  for (const path of ['apps/web/src/ui/Briefing.tsx', 'apps/web/src/screens/About.tsx', 'apps/web/src/theme.css']) {
    const changed = await changedBy(path);
    assert.deepEqual(unitsOf('browser', 'browser-matrix', 'browser-engines').filter(unit => !changed.has(unit)), [], path);
    strays(changed, 'server', 'node', 'protocol');
  }
});

/* A spec of the database imports the server code it drives, as a test of the server does. */
test('a spec of the database follows the server source it imports', async () => {
  assert.ok((await changedBy('apps/server/src/modules/tasks/wait-escalation.ts')).has('server-postgres:apps/server/test/postgres/wait-escalation.pg.spec.ts'));
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
