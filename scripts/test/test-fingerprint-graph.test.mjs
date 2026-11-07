import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { trackedIn } from './tracked-files.mjs';

/* The real repository, its real manifest and the real Vitest graph. A file wrongly reused is the one real harm of reuse, so whatever
   Vitest would run for a change must have a fingerprint that changes with it. */
const root = fileURLToPath(new URL('../..', import.meta.url));
const PROBE = "const {probe}=await import('./scripts/test/related-probe.mjs');process.stdout.write(JSON.stringify(await probe({root:process.cwd()},JSON.parse(process.argv[1]))));";
const BUILT = ['packages/protocol/dist/index.js', 'apps/node/dist/test-fingerprint.js'];
const SOURCE = /^(?:apps\/[^/]+|packages\/[^/]+)\/src\/.+\.tsx?$/;
const SAMPLE_EVERY = 40;
/* What may also change with a file of another group: the few tests that name it or a whole folder. */
const STRAY = 0.05;
const key = unit => `${unit.suiteId}:${unit.file}`;
let manifest, input, inventory, prints, fingerprint;

before(async () => {
  if (!BUILT.every(file => existsSync(root + file))) for (const name of ['protocol', 'node']) execFileSync('npm', ['run', '-s', 'build', '-w', `@hornhoof/${name}`], { cwd: root, stdio: 'ignore' });
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  const { listTestUnits } = await import('../../apps/node/dist/test-environment.js');
  fingerprint = await import('../../apps/node/dist/test-fingerprint.js');
  manifest = parseTestEnvironment(readFileSync(`${root}.hornhoof/test-environment.json`, 'utf8'));
  const tracked = trackedIn(root);
  inventory = listTestUnits(manifest, tracked);
  input = { description: { manifest, inventory, inputDigests: [], runtimeCapabilities: [{ id: 'node', version: process.versions.node, fingerprint: 'a'.repeat(64) }] }, tracked, texts: new Map(fingerprint.codeFilesOf(tracked).map(path => [path, readFileSync(root + path, 'utf8')])) };
  prints = await fingerprint.fingerprintUnits(input);
});

/* The units whose fingerprint differs once a path holds other content. */
async function changedBy(path) {
  assert.ok(input.tracked.some(entry => entry.path === path), `${path} is not tracked`);
  const was = new Map(prints.map(unit => [key(unit), unit.fingerprint]));
  const tracked = input.tracked.map(entry => entry.path === path ? { ...entry, oid: 'f'.repeat(40) } : entry);
  return new Set((await fingerprint.fingerprintUnits({ ...input, tracked })).filter(unit => was.get(key(unit)) !== unit.fingerprint).map(key));
}
const unitsOf = (...suiteIds) => inventory.filter(unit => suiteIds.includes(unit.suiteId)).map(key);

test('whatever Vitest would run for a change has a fingerprint that changes with it', async () => {
  const sources = input.tracked.map(entry => entry.path).filter(path => SOURCE.test(path)).filter((_, index) => index % SAMPLE_EVERY === 0);
  assert.ok(sources.length >= 10, `only ${sources.length} sources sampled`);
  for (const source of [...sources, 'packages/protocol/src/test-environment.ts']) {
    const { selected } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, JSON.stringify([source])], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }));
    const changed = await changedBy(source), expected = new Set(selected.map(row => row.file));
    assert.deepEqual(inventory.filter(unit => expected.has(unit.file) && !changed.has(key(unit))).map(key), [], `missed for ${source}`);
  }
});

const strays = (changed, ...suiteIds) => {
  const units = unitsOf(...suiteIds);
  assert.ok(units.filter(unit => changed.has(unit)).length <= units.length * STRAY, `too much of ${suiteIds} changed: ${units.filter(unit => changed.has(unit)).length} of ${units.length}`);
};

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
