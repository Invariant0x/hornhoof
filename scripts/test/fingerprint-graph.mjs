import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { trackedIn } from './tracked-files.mjs';

/* The real repository, its real manifest and the real Vitest graph. A file wrongly reused is the one real harm of reuse, so whatever
   Vitest would run for a change must have a fingerprint that changes with it. What the tests of the fingerprint graph share: their
   files run side by side, and each prepares this once. */
export const root = fileURLToPath(new URL('../..', import.meta.url));
export const PROBE = "const {probe}=await import('./scripts/test/related-probe.mjs');process.stdout.write(JSON.stringify(await probe({root:process.cwd()},JSON.parse(process.argv[1]))));";
const BUILT = ['packages/protocol/dist/index.js', 'apps/node/dist/test-fingerprint.js'];
export const SOURCE = /^(?:apps\/[^/]+|packages\/[^/]+)\/src\/.+\.tsx?$/;
export const SAMPLE_EVERY = 40;
/* What may also change with a file of another group: the few tests that name it or a whole folder. */
const STRAY = 0.05;
export const key = unit => `${unit.suiteId}:${unit.file}`;
export let manifest, input, inventory, prints, fingerprint;

export async function prepare() {
  if (!BUILT.every(file => existsSync(root + file))) for (const name of ['protocol', 'node']) execFileSync('npm', ['run', '-s', 'build', '-w', `@hornhoof/${name}`], { cwd: root, stdio: 'ignore' });
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  const { listTestUnits } = await import('../../apps/node/dist/test-environment.js');
  fingerprint = await import('../../apps/node/dist/test-fingerprint.js');
  manifest = parseTestEnvironment(readFileSync(`${root}.hornhoof/test-environment.json`, 'utf8'));
  const tracked = trackedIn(root);
  inventory = listTestUnits(manifest, tracked);
  input = { description: { manifest, inventory, inputDigests: [], runtimeCapabilities: [{ id: 'node', version: process.versions.node, fingerprint: 'a'.repeat(64) }] }, tracked, texts: new Map(fingerprint.codeFilesOf(tracked).map(path => [path, readFileSync(root + path, 'utf8')])) };
  prints = await fingerprint.fingerprintUnits(input);
}

/* The units whose fingerprint differs once a path holds other content. */
export async function changedBy(path) {
  assert.ok(input.tracked.some(entry => entry.path === path), `${path} is not tracked`);
  const was = new Map(prints.map(unit => [key(unit), unit.fingerprint]));
  const tracked = input.tracked.map(entry => entry.path === path ? { ...entry, oid: 'f'.repeat(40) } : entry);
  return new Set((await fingerprint.fingerprintUnits({ ...input, tracked })).filter(unit => was.get(key(unit)) !== unit.fingerprint).map(key));
}
export const unitsOf = (...suiteIds) => inventory.filter(unit => suiteIds.includes(unit.suiteId)).map(key);

export const strays = (changed, ...suiteIds) => {
  const units = unitsOf(...suiteIds);
  assert.ok(units.filter(unit => changed.has(unit)).length <= units.length * STRAY, `too much of ${suiteIds} changed: ${units.filter(unit => changed.has(unit)).length} of ${units.length}`);
};
