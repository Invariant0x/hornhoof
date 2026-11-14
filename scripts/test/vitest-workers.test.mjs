import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { test } from 'node:test';
import { vitestWorkers } from './vitest-workers.mjs';

const GiB = 1024 ** 3;
const none = {};

/* A fork of the server suites holds a PGlite database: a machine with little free memory and many cores went to swap with
   one worker per core, and tests ended at their limit instead of for a reason. */
test('takes one worker for each 2.5 GiB of free memory, so 7 GiB free on 16 cores gives 2', () => {
  assert.equal(vitestWorkers({ available: 7 * GiB, cores: 16, env: none }), 2);
  assert.equal(vitestWorkers({ available: 7.5 * GiB, cores: 16, env: none }), 3);
});

test('takes no more workers than the machine has cores, so 101 GiB free on 8 cores gives 8', () => {
  assert.equal(vitestWorkers({ available: 101 * GiB, cores: 8, env: none }), 8);
});

test('takes one worker however little memory is free', () => {
  assert.equal(vitestWorkers({ available: 1 * GiB, cores: 4, env: none }), 1);
  assert.equal(vitestWorkers({ available: 0, cores: 4, env: none }), 1);
});

test('takes the count named in HH_VITEST_MAX_WORKERS first, then the one in VITEST_MAX_WORKERS', () => {
  const machine = { available: 101 * GiB, cores: 8 };
  assert.equal(vitestWorkers({ ...machine, env: { HH_VITEST_MAX_WORKERS: '3', VITEST_MAX_WORKERS: '5' } }), 3);
  assert.equal(vitestWorkers({ ...machine, env: { VITEST_MAX_WORKERS: '5' } }), 5);
});

test('counts from the machine when a named count is no whole number above zero', () => {
  for (const named of ['', '0', '-2', '2.5', 'four', ' 3']) {
    assert.equal(vitestWorkers({ available: 7 * GiB, cores: 16, env: { HH_VITEST_MAX_WORKERS: named } }), 2, `"${named}"`);
  }
});

test('counts on this machine by itself between one worker and its cores', () => {
  const workers = vitestWorkers();
  assert.ok(Number.isInteger(workers) && workers >= 1 && workers <= availableParallelism(), String(workers));
});

test('gives the product run of Vitest that many workers', async () => {
  const before = process.env.HH_VITEST_MAX_WORKERS;
  process.env.HH_VITEST_MAX_WORKERS = '3';
  try {
    const { default: config } = await import('../../vitest.product.config.mjs?workers');
    assert.equal(config.test.maxWorkers, 3);
  } finally {
    if (before === undefined) delete process.env.HH_VITEST_MAX_WORKERS;
    else process.env.HH_VITEST_MAX_WORKERS = before;
  }
});
