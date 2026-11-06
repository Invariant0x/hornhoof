import { describe, expect, it } from 'vitest';
import type { TestUnit } from '@hornhoof/protocol';
import { collectVitestImpact, mapPytestImpact, type ImpactCollection, type VitestImpactInput } from '../src/test-impact-adapters.js';

const unit = (suiteId: string, file: string): TestUnit => ({ suiteId, file, selectionUnit: file });
function setup(): { input: VitestImpactInput; collection: ImpactCollection } {
  return {
    input: { changed: ['apps/node/src/a.ts'], projectSuites: { node: ['node'], server: ['server'] },
      inventory: [unit('node', 'apps/node/test/a.test.ts'), unit('node', 'apps/node/test/b.test.ts'), unit('server', 'apps/server/test/c.test.ts')] },
    collection: { projects: ['node', 'server'], all: [{ project: 'node', file: 'apps/node/test/a.test.ts' },
      { project: 'node', file: 'apps/node/test/b.test.ts' }, { project: 'server', file: 'apps/server/test/c.test.ts' }],
    selected: [{ project: 'node', file: 'apps/node/test/a.test.ts' }] },
  };
}
const unavailable = { adapter: 'vitest-related', status: 'unavailable', units: [] };

describe('explicit Vitest collection adapter', () => {
  it('maps actual project/file identities to canonical units without broadening', async () => {
    const { input, collection } = setup();
    expect(await collectVitestImpact(input, async () => collection)).toEqual({ adapter: 'vitest-related', status: 'ready', units: [unit('node', 'apps/node/test/a.test.ts')] });
  });
  it('keeps cross-package edges and unions separate changed-file collections', async () => {
    const { input, collection } = setup(); input.changed.push('apps/server/src/c.ts');
    expect(await collectVitestImpact(input, async file => ({ ...collection, selected: file.startsWith('apps/server') ? [collection.all[2]!] : collection.selected })))
      .toMatchObject({ status: 'ready', units: [unit('node', 'apps/node/test/a.test.ts'), unit('server', 'apps/server/test/c.test.ts')] });
  });
  it('preserves multiple canonical suites for one collected file', async () => {
    const { input, collection } = setup(); input.projectSuites.node!.push('node-extra'); input.inventory.push(unit('node-extra', 'apps/node/test/a.test.ts'));
    const result = await collectVitestImpact(input, async () => collection);
    expect(result.units).toEqual([unit('node', 'apps/node/test/a.test.ts'), unit('node-extra', 'apps/node/test/a.test.ts')]);
  });
  it('accepts a proven empty graph without treating it as collection failure', async () => {
    const { input, collection } = setup(); collection.selected = [];
    expect(await collectVitestImpact(input, async () => collection)).toMatchObject({ status: 'ready', units: [] });
  });
  it.each(['empty', 'unrelated'])('fails wide when a changed test is outside the collection with %s selected tests', async selection => {
    const { input, collection } = setup(); input.changed = ['apps/node/e2e/agent-window-overlays.spec.ts'];
    if (selection === 'empty') collection.selected = [];
    expect(await collectVitestImpact(input, async () => collection)).toEqual(unavailable);
  });
  it('keeps a changed test that belongs to the complete collection selectable', async () => {
    const { input, collection } = setup(); input.changed = ['apps/node/test/a.test.ts'];
    expect(await collectVitestImpact(input, async () => collection)).toEqual({ adapter: 'vitest-related', status: 'ready', units: [unit('node', 'apps/node/test/a.test.ts')] });
  });
  it('does not collect when there are no changes', async () => {
    const { input } = setup(); input.changed = [];
    expect(await collectVitestImpact(input, async () => { throw new Error('unused'); })).toMatchObject({ status: 'ready', units: [] });
  });
  it('does not mutate caller collections or inventory', async () => {
    const { input, collection } = setup(), before = structuredClone({ input, collection });
    const result = await collectVitestImpact(input, async () => collection); result.units[0]!.file = 'different';
    expect({ input, collection }).toEqual(before);
  });
  it.each(['unknown-project', 'unknown-file', 'missing-inventory', 'uncollected-selection', 'missing-project'] as const)('fails wide for %s', async issue => {
    const { input, collection } = setup();
    if (issue === 'unknown-project') collection.all.push({ project: 'other', file: 'other/test.ts' });
    if (issue === 'unknown-file') collection.all.push({ project: 'node', file: 'apps/node/test/unmapped.test.ts' });
    if (issue === 'missing-inventory') collection.all.splice(1, 1);
    if (issue === 'uncollected-selection') collection.selected.push({ project: 'server', file: 'other.ts' });
    if (issue === 'missing-project') collection.projects.pop();
    expect(await collectVitestImpact(input, async () => collection)).toEqual(unavailable);
  });
  it('does not keep a partial narrow answer after a collector error', async () => {
    const { input, collection } = setup(); input.changed.push('other.ts');
    expect(await collectVitestImpact(input, async file => { if (file === 'other.ts') throw new Error('failed'); return collection; })).toEqual(unavailable);
  });
  it('rejects an inventory that changes between changed-file collections', async () => {
    const { input, collection } = setup(); input.changed.push('other.ts');
    expect(await collectVitestImpact(input, async file => file === 'other.ts' ? { ...collection, all: collection.all.slice(1) } : collection)).toEqual(unavailable);
  });
  it('rejects missing project and mapping together instead of ignoring its canonical suite', async () => {
    const { input, collection } = setup(); input.requiredSuiteIds = ['node', 'server'];
    delete input.projectSuites.server; collection.projects = ['node']; collection.all.pop();
    expect(await collectVitestImpact(input, async () => collection)).toEqual(unavailable);
  });
  it('keeps explicitly declared non-Vitest inventory outside the adapter boundary', async () => {
    const { input, collection } = setup(); input.requiredSuiteIds = ['node', 'server'];
    input.inventory.push(unit('python', 'python/test_a.py'));
    expect(await collectVitestImpact(input, async () => collection)).toMatchObject({ status: 'ready', units: [unit('node', 'apps/node/test/a.test.ts')] });
  });
});

describe('pytest collection adapter', () => {
  const inventory = [unit('python', 'python/tests/test_a.py'), unit('python', 'python/tests/test_b.py')];
  it('maps a Python package-relative selection without changing canonical units', () => {
    expect(mapPytestImpact({ status: 'ready', selected: ['tests/test_b.py'], reason: null }, inventory, 'python', 'python'))
      .toEqual({ adapter: 'pytest', status: 'ready', units: [unit('python', 'python/tests/test_b.py')] });
  });
  it('keeps a proven empty Python selection', () => {
    expect(mapPytestImpact({ status: 'ready', selected: [], reason: null }, inventory, 'python', 'python')).toMatchObject({ status: 'ready', units: [] });
  });
  it.each(['../test.py', '/test.py', 'tests/missing.py', 'tests\\test_a.py'])('fails wide for Python path %s', file => {
    expect(mapPytestImpact({ status: 'ready', selected: [file], reason: null }, inventory, 'python', 'python')).toMatchObject({ status: 'unavailable', units: [] });
  });
  it('keeps an unavailable Python graph unavailable', () => {
    expect(mapPytestImpact({ status: 'unavailable', selected: [], reason: 'dynamic_import' }, inventory, 'python', 'python')).toMatchObject({ status: 'unavailable', units: [] });
  });
});
