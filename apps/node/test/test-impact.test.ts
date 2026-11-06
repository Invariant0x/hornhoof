import { describe, expect, it } from 'vitest';
import type { TestUnit } from '@hornhoof/protocol';
import { selectAffectedTests, type ImpactInput, type ImpactSelection } from '../src/test-impact.js';

const unit = (suiteId: string, file: string): TestUnit => ({ suiteId, file, selectionUnit: file });
function fixture(): ImpactInput {
  return {
    changes: [{ path: 'apps/node/src/a.ts', kind: 'modified' }],
    environment: {
      packages: [
        { id: 'node', root: 'apps/node', language: 'typescript', suiteIds: ['node'] },
        { id: 'server', root: 'apps/server', language: 'typescript', suiteIds: ['server'] },
        { id: 'python', root: 'python', language: 'python', suiteIds: ['python'] },
        { id: 'native', root: 'native', language: 'go', suiteIds: ['native'] },
      ],
      impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'supported',
        up: { program: 'python3', args: ['migrate.py', 'up'], cwd: 'apps/node' },
        down: { program: 'python3', args: ['migrate.py', 'down'], cwd: 'apps/node' } } },
      inventory: [unit('node', 'apps/node/test/a.test.ts'), unit('node', 'apps/node/test/b.test.ts'), unit('node', 'apps/node/test/new.test.ts'),
        unit('server', 'apps/server/test/c.test.ts'), unit('python', 'python/tests/test_a.py'), unit('python', 'python/tests/test_b.py'), unit('native', 'native/unit_test.go')],
    },
    graphs: [{ adapter: 'vitest-related', status: 'ready', units: [unit('node', 'apps/node/test/a.test.ts')] }],
  };
}
const files = (result: ImpactSelection) => result.units.map(value => value.file).sort();
const mode = (result: ImpactSelection, id: string) => result.packages.find(value => value.packageId === id)?.mode;
const nodeFiles = ['apps/node/test/a.test.ts', 'apps/node/test/b.test.ts', 'apps/node/test/new.test.ts'];

describe('pure commit impact selection', () => {
  it('selects exactly the graph dependencies of file X', () => {
    const result = selectAffectedTests(fixture());
    expect(result.status).toBe('ready'); expect(files(result)).toEqual(['apps/node/test/a.test.ts']);
    expect(mode(result, 'node')).toBe('related');
  });

  it('preserves related test edges into a different package', () => {
    const input = fixture(); input.graphs[0]!.units.push(unit('server', 'apps/server/test/c.test.ts'));
    expect(files(selectAffectedTests(input))).toEqual(['apps/node/test/a.test.ts', 'apps/server/test/c.test.ts']);
  });

  it('selects nothing for an empty change set', () => {
    const input = fixture(); input.changes = [];
    expect(selectAffectedTests(input)).toMatchObject({ status: 'ready', units: [], packages: [], migrationChecks: [], problems: [] });
  });

  it('always selects a newly added test even when the graph has no edges', () => {
    const input = fixture(); input.changes = [{ path: 'apps/node/test/new.test.ts', kind: 'added' }]; input.graphs[0]!.units = [];
    expect(files(selectAffectedTests(input))).toEqual(['apps/node/test/new.test.ts']);
  });

  it('blocks a new test missing from the supplied inventory instead of omitting it', () => {
    const input = fixture(); input.changes = [{ path: 'apps/node/test/not-listed.test.ts', kind: 'added' }];
    expect(selectAffectedTests(input)).toMatchObject({ status: 'blocked', problems: [{ code: 'new_test_unmapped' }] });
  });

  it('accepts a proven empty graph for an existing source without inventing tests', () => {
    const input = fixture(); input.graphs[0]!.units = [];
    expect(selectAffectedTests(input)).toMatchObject({ status: 'ready', units: [] });
  });

  it('deduplicates test units deterministically without mutating inputs', () => {
    const input = fixture(); input.changes.push({ ...input.changes[0]! }); input.graphs[0]!.units.push(...input.graphs[0]!.units);
    const before = structuredClone(input), result = selectAffectedTests(input);
    expect(files(result)).toEqual(['apps/node/test/a.test.ts']); expect(input).toEqual(before);
  });

  it('keeps distinct suite identities for the same test file', () => {
    const input = fixture(); input.environment.packages[0]!.suiteIds.push('node-extra');
    input.environment.inventory.push(unit('node-extra', 'apps/node/test/a.test.ts'));
    input.graphs[0]!.units.push(unit('node-extra', 'apps/node/test/a.test.ts'));
    expect(selectAffectedTests(input).units.map(value => value.suiteId).sort()).toEqual(['node', 'node-extra']);
  });

  it('honors environment fullPackageGlobs without widening unrelated packages', () => {
    const input = fixture(); input.changes = [{ path: 'data/table.dsl', kind: 'modified' }];
    input.environment.impact.fullPackageGlobs = [{ globs: ['data/**'], suiteIds: ['server'] }];
    const result = selectAffectedTests(input);
    expect(files(result)).toEqual(['apps/server/test/c.test.ts']); expect(mode(result, 'server')).toBe('whole-package');
  });

  it.each([
    ['apps/node/migrations/001.sql', 'migration'], ['apps/node/src/schema.ts', 'schema'],
    ['apps/node/vitest.config.ts', 'configuration'], ['apps/node/.env.runtime', 'environment'],
    ['apps/node/src/routes/list.ts', 'routes'], ['apps/node/test/fixtures/value.json', 'fixtures'],
    ['apps/node/src/i18n/en.ts', 'strings'], ['apps/node/scripts/tool.mjs', 'scripts'],
    ['apps/node/install.sh', 'installation'], ['apps/node/update.sh', 'updates'],
  ])('runs the complete affected package for non-graph path %s', (path, reason) => {
    const input = fixture(); input.changes = [{ path, kind: 'modified' }];
    const result = selectAffectedTests(input);
    expect(files(result)).toEqual(nodeFiles); expect(mode(result, 'node')).toBe('whole-package');
    expect(result.packages.find(value => value.packageId === 'node')?.reasons).toContainEqual({ code: reason, path });
  });

  it.each(['templates/skills/a.md', 'packages/shared/src/key.ts', 'contracts/api.json'])('widens repository-wide non-graph path %s', path => {
    const input = fixture(); input.changes = [{ path, kind: 'modified' }];
    const result = selectAffectedTests(input);
    expect(result.units).toHaveLength(7); expect(result.packages.every(value => value.mode === 'whole-package')).toBe(true);
  });

  it('runs the complete package for an unsupported language', () => {
    const input = fixture(); input.changes = [{ path: 'native/main.go', kind: 'modified' }];
    const result = selectAffectedTests(input);
    expect(files(result)).toEqual(['native/unit_test.go']); expect(mode(result, 'native')).toBe('whole-package');
  });

  it('runs the complete package for an unsupported source type', () => {
    const input = fixture(); input.changes = [{ path: 'apps/node/src/value.rs', kind: 'modified' }];
    expect(files(selectAffectedTests(input))).toEqual(nodeFiles);
  });

  it.each(['missing', 'unavailable', 'ambiguous'] as const)('falls back to the whole package for a %s adapter graph', state => {
    const input = fixture();
    if (state === 'missing') input.graphs = [];
    else if (state === 'unavailable') input.graphs[0]!.status = 'unavailable';
    else input.graphs.push(structuredClone(input.graphs[0]!));
    const result = selectAffectedTests(input);
    expect(files(result)).toEqual(nodeFiles); expect(mode(result, 'node')).toBe('whole-package');
  });

  it('refuses narrow graph evidence that names a unit outside inventory', () => {
    const input = fixture(); input.graphs[0]!.units = [unit('node', 'apps/node/test/unknown.test.ts')];
    expect(files(selectAffectedTests(input))).toEqual(nodeFiles);
  });

  it('uses the pytest adapter graph for Python without executing TypeScript graph rows', () => {
    const input = fixture(); input.changes = [{ path: 'python/src/a.py', kind: 'modified' }];
    input.graphs.push({ adapter: 'pytest', status: 'ready', units: [unit('python', 'python/tests/test_a.py')] });
    expect(files(selectAffectedTests(input))).toEqual(['python/tests/test_a.py']);
  });

  it('uses the declared default language when a package omits its override', () => {
    const input = fixture(); input.environment.impact.adapter = 'python'; delete input.environment.packages[2]!.language;
    input.changes = [{ path: 'python/src/a.py', kind: 'modified' }];
    input.graphs.push({ adapter: 'pytest', status: 'ready', units: [unit('python', 'python/tests/test_a.py')] });
    expect(files(selectAffectedTests(input))).toEqual(['python/tests/test_a.py']);
  });

  it('supports JavaScript through the Vitest related adapter', () => {
    const input = fixture(); input.environment.packages[0]!.language = 'javascript'; input.changes[0]!.path = 'apps/node/src/a.mjs';
    expect(files(selectAffectedTests(input))).toEqual(['apps/node/test/a.test.ts']);
  });

  it('falls back to a whole package when the source was deleted', () => {
    const input = fixture(); input.changes[0]!.kind = 'deleted';
    expect(files(selectAffectedTests(input))).toEqual(nodeFiles);
  });

  it('retains both old and new package coverage for a cross-package rename', () => {
    const input = fixture(); input.changes = [{ path: 'apps/server/src/a.ts', previousPath: 'apps/node/src/a.ts', kind: 'renamed' }];
    expect(files(selectAffectedTests(input))).toEqual([...nodeFiles, 'apps/server/test/c.test.ts']);
  });

  it.each(['README.md', 'apps/node-extra/src/a.ts'])('runs all packages for an unmapped path %s', path => {
    const input = fixture(); input.changes = [{ path, kind: 'modified' }];
    expect(selectAffectedTests(input).units).toHaveLength(7);
  });

  it.each(['../outside.ts', '/tmp/outside.ts', 'C:/outside.ts', 'apps\\node\\a.ts', 'apps/node/../a.ts'])('blocks an unsafe changed path %s', path => {
    const input = fixture(); input.changes = [{ path, kind: 'modified' }];
    expect(selectAffectedTests(input)).toMatchObject({ status: 'blocked', units: [], problems: [{ code: 'impact_path_invalid' }] });
  });

  it('keeps migration up and down explicit and ordered even for multiple changed migrations', () => {
    const input = fixture(); input.changes = [{ path: 'apps/node/migrations/a.sql', kind: 'added' }, { path: 'apps/node/migrations/b.sql', kind: 'modified' }];
    const result = selectAffectedTests(input);
    expect(result.migrationChecks).toEqual([
      { direction: 'up', command: { program: 'python3', args: ['migrate.py', 'up'], cwd: 'apps/node' } },
      { direction: 'down', command: { program: 'python3', args: ['migrate.py', 'down'], cwd: 'apps/node' } },
    ]);
    expect(files(result)).toEqual(nodeFiles);
  });

  it('blocks migration readiness when a down check is unsupported', () => {
    const input = fixture(); input.changes[0]!.path = 'apps/node/migrations/a.sql';
    input.environment.impact.migrationCheck = { status: 'unsupported', reason: 'Fixture has no down command.' };
    const result = selectAffectedTests(input);
    expect(result.status).toBe('blocked'); expect(result.problems).toContainEqual({ code: 'migration_check_unsupported' });
    expect(result.migrationChecks).toEqual([]); expect(files(result)).toEqual(nodeFiles);
  });
});
