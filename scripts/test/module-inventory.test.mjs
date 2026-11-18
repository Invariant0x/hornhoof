import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inventoryOf, renderInventory } from '../module-inventory.mjs';

test('counts tracked source by package and by its actual module', () => {
  const files = [
    'apps/server/src/modules/tasks/engine.ts', 'apps/server/src/modules/tasks/waits/read.ts',
    'apps/server/src/modules/phones/queue.ts', 'apps/server/src/main.ts', 'apps/server/src/db/schema.ts',
    'apps/web/src/screens/Tasks.tsx', 'apps/web/src/theme.css', 'apps/web/src/main.tsx',
    'apps/node/src/providers/codex.ts', 'packages/protocol/src/index.ts',
    'apps/server/test/tasks.test.ts', 'docs/evidence/run.log', 'node_modules/package/src/index.ts',
  ];
  assert.deepEqual(inventoryOf(files), [
    { part: 'apps/server', files: 5, modules: [['db', 1], ['main.ts', 1], ['modules/phones', 1], ['modules/tasks', 2]] },
    { part: 'apps/web', files: 3, modules: [['main.tsx', 1], ['screens', 1], ['theme.css', 1]] },
    { part: 'apps/node', files: 1, modules: [['providers', 1]] },
    { part: 'packages/protocol', files: 1, modules: [['index.ts', 1]] },
  ]);
  assert.deepEqual(inventoryOf(files.toReversed()), inventoryOf(files));
});

test('renders a pinned release and the commands that reproduce its inventory', () => {
  const text = renderInventory({ commit: 'a'.repeat(40), version: '0.32.0', files: ['apps/server/src/modules/calls/calls.ts'] });
  assert.ok(text.includes('Release **0.32.0**, commit `' + 'a'.repeat(40) + '`'));
  assert.ok(text.includes('| `modules/calls` | 1 |'));
  assert.ok(text.includes('node scripts/module-inventory.mjs ' + 'a'.repeat(40)));
  assert.ok(!text.includes('modules/outbound'));
  assert.ok(!text.includes('modules/model-checks'));
});
