import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, test } from 'node:test';
import { changedBy, input, inventory, key, PROBE, prepare, root, SAMPLE_EVERY, SOURCE } from './fingerprint-graph.mjs';

before(prepare);

test('whatever Vitest would run for a change has a fingerprint that changes with it', async () => {
  const sources = input.tracked.map(entry => entry.path).filter(path => SOURCE.test(path)).filter((_, index) => index % SAMPLE_EVERY === 0);
  assert.ok(sources.length >= 10, `only ${sources.length} sources sampled`);
  /* The even half of the sample: test-fingerprint-graph-sample.test.mjs takes the odd half beside it, as each probe starts a
     Vitest of its own. */
  for (const source of [...sources.filter((_, index) => index % 2 === 0), 'packages/protocol/src/test-environment.ts']) {
    const { selected } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', PROBE, JSON.stringify([source])], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }));
    const changed = await changedBy(source), expected = new Set(selected.map(row => row.file));
    assert.deepEqual(inventory.filter(unit => expected.has(unit.file) && !changed.has(key(unit))).map(key), [], `missed for ${source}`);
  }
});
