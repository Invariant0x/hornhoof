import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { test } from 'node:test';

/* The product run's config sizes its workers by the node's one calculation, apps/node/src/vitest-workers.ts, whose own tests
   say how: what is checked here is that the config takes it. */
async function workersWith(env, tag) {
  const names = ['HH_VITEST_MAX_WORKERS', 'VITEST_MAX_WORKERS'], before = names.map(name => process.env[name]);
  for (const name of names) delete process.env[name];
  Object.assign(process.env, env);
  try {
    const { default: config } = await import(`../../vitest.product.config.mjs?${tag}`);
    return config.test.maxWorkers;
  } finally {
    names.forEach((name, index) => (before[index] === undefined ? delete process.env[name] : (process.env[name] = before[index])));
  }
}

test('gives the product run of Vitest the count the machine names, HH_VITEST_MAX_WORKERS before VITEST_MAX_WORKERS', async () => {
  assert.equal(await workersWith({ HH_VITEST_MAX_WORKERS: '3', VITEST_MAX_WORKERS: '5' }, 'both'), 3);
  assert.equal(await workersWith({ VITEST_MAX_WORKERS: '5' }, 'vitest'), 5);
});

test('counts on this machine by itself between one worker and its cores when nothing names a count', async () => {
  const workers = await workersWith({}, 'none');
  assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= availableParallelism(), String(workers));
});
