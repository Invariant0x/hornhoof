import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';
import { cyclicGroups, serverGraph, valueGraph } from '../server-imports.mjs';

test('counts runtime imports and reexports without type-only edges', () => {
  const graph = valueGraph(new Map([
    ['a.ts', "import type { B } from './b.js'; import { type B, run } from './b.js'; export type { C } from './c.js'; export { type C } from './c.js';"],
    ['b.ts', "export * from './c.js';"],
    ['c.ts', "import './a.js';"],
  ]));
  assert.deepEqual([...graph], [['a.ts', ['b.ts']], ['b.ts', ['c.ts']], ['c.ts', ['a.ts']]]);
  assert.deepEqual(cyclicGroups(graph), [['a.ts', 'b.ts', 'c.ts']]);
});

test('separates cycles, self imports and acyclic consumers in a stable order', () => {
  const graph = new Map([['z.ts', ['b.ts']], ['b.ts', ['a.ts']], ['a.ts', ['b.ts']], ['c.ts', ['c.ts']], ['leaf.ts', []]]);
  assert.deepEqual(cyclicGroups(graph), [['a.ts', 'b.ts'], ['c.ts']]);
});

test('resolves nested relative paths and ignores dynamic and external imports', () => {
  const graph = valueGraph(new Map([
    ['feature/a.ts', "import { b } from '../b.js'; import 'node:fs'; void import('../c.js');"],
    ['b.ts', "import type X from './feature/a.js';"],
    ['c.ts', 'export const c = 1;'],
  ]));
  assert.deepEqual(graph.get('feature/a.ts'), ['b.ts']);
  assert.deepEqual(graph.get('b.ts'), []);
  assert.deepEqual(cyclicGroups(graph), []);
});

test('server runtime imports have no cycles', () => {
  assert.deepEqual(cyclicGroups(serverGraph(fileURLToPath(new URL('../..', import.meta.url)))), []);
});
