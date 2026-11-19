import { readFileSync } from 'node:fs';
import { parseTestEnvironment } from '@hornhoof/protocol';
import { expect, it } from 'vitest';
import { partBudget } from '../src/modules/testruns/part-budget.js';

const manifest = parseTestEnvironment(JSON.parse(readFileSync(new URL('../../../.hornhoof/test-environment.json', import.meta.url), 'utf8')));
const suite = (suiteId: string) => ({ kind: 'suite' as const, suiteId, files: [] });

it('uses the pinned Playwright workers and sizes unpinned Vitest workers from part memory', () => {
  expect(partBudget(4, manifest, suite('browser'))).toEqual({ memoryBytes: 4 * 2 ** 30, cores: 2, vitestWorkers: 1 });
  expect(partBudget(4, manifest, suite('browser-matrix')).cores).toBe(2);
  expect(partBudget(9, manifest, suite('node'))).toMatchObject({ cores: 3, vitestWorkers: 3 });
  expect(partBudget(1)).toMatchObject({ cores: 1, vitestWorkers: 1 });
});

it('reserves the largest worker count among the suites of one batch', () => {
  const shard = { index: 1, count: 1 };
  const budget = partBudget(4, manifest, { kind: 'batch', version: 2, expectedCommitSha: 'a'.repeat(40), selections: [
    { ...suite('node'), shard }, { ...suite('browser'), shard },
  ] });
  expect(budget).toMatchObject({ cores: 2, vitestWorkers: 1 });
});
