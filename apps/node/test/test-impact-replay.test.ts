import { describe, expect, it } from 'vitest';
import type { TestUnit } from '@hornhoof/protocol';
import { parseImpactDiff, replayImpactChanges, type ImpactReplayInput } from '../src/test-impact-replay.js';

const sha = (value: number): string => value.toString(16).padStart(40, '0');
const unit = (suiteId: string, file: string): TestUnit => ({ suiteId, file, selectionUnit: file });
function fixture(): ImpactReplayInput {
  return {
    candidate: sha(100), commits: Array.from({ length: 10 }, (_, i) => ({ commit: sha(i + 1), parent: sha(i), changes: [{ kind: 'modified', path: 'app/src/a.ts' }] })),
    environment: { packages: [{ id: 'app', root: 'app', language: 'typescript', suiteIds: ['app'] }],
      inventory: [unit('app', 'app/test/a.test.ts'), unit('app', 'app/test/b.test.ts'), unit('app', 'app/test/c.test.ts')],
      impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No migrations' } } },
    collect: async () => [{ adapter: 'vitest-related', status: 'ready', units: [unit('app', 'app/test/a.test.ts')] }],
  };
}

describe('literal Git name-status input', () => {
  it('preserves spaces, tabs and newlines instead of splitting file names', () => {
    expect(parseImpactDiff(Buffer.from('M\0app/src/two words.ts\0A\0app/test/tab\tname.test.ts\0D\0app/src/new\nline.ts\0'))).toEqual([
      { kind: 'modified', path: 'app/src/two words.ts' }, { kind: 'added', path: 'app/test/tab\tname.test.ts' }, { kind: 'deleted', path: 'app/src/new\nline.ts' },
    ]);
  });
  it('retains both paths of a rename and conservatively treats a copy as a rename', () => {
    expect(parseImpactDiff(Buffer.from('R100\0old/a.ts\0new/a.ts\0C090\0a.ts\0b.ts\0'))).toEqual([
      { kind: 'renamed', previousPath: 'old/a.ts', path: 'new/a.ts' }, { kind: 'renamed', previousPath: 'a.ts', path: 'b.ts' },
    ]);
  });
  it('accepts an empty diff', () => { expect(parseImpactDiff(Buffer.alloc(0))).toEqual([]); });
  it.each(['M\0', 'R100\0old.ts\0', 'M\0file.ts', 'U\0file.ts\0', 'M\0\0'])('refuses incomplete or unsupported diff %j', data => {
    expect(() => parseImpactDiff(Buffer.from(data))).toThrow();
  });
  it('refuses invalid UTF8 bytes instead of replacing a file name', () => { expect(() => parseImpactDiff(Uint8Array.from([77, 0, 255, 0]))).toThrow(); });
});

describe('ten historical diffs at one pinned graph candidate', () => {
  it('records all ten selections with their exact candidate and denominator', async () => {
    const result = await replayImpactChanges(fixture());
    expect(result).toMatchObject({ candidate: sha(100), scope: 'historical-diffs-at-candidate', status: 'recorded' });
    expect(result.rows).toHaveLength(10);
    expect(result.rows[0]).toMatchObject({ commit: sha(1), parent: sha(0), changed: ['app/src/a.ts'], selectedCount: 1, totalCount: 3, widthPercent: 33.33,
      comparison: { status: 'unavailable', reason: 'full_comparator_missing' } });
  });
  it('does not convert absent comparator evidence into zero misses', async () => {
    const result = await replayImpactChanges(fixture());
    expect(result.rows.map(row => row.comparison)).toEqual(Array.from({ length: 10 }, () => ({ status: 'unavailable', reason: 'full_comparator_missing' })));
  });
  it('records a full package fallback and its cause', async () => {
    const input = fixture(); input.commits[0]!.changes = [{ path: 'app/package.json', kind: 'modified' }];
    const result = await replayImpactChanges(input);
    expect(result.rows[0]).toMatchObject({ selectedCount: 3, widthPercent: 100, selection: { packages: [{ mode: 'whole-package', reasons: [{ code: 'configuration', path: 'app/package.json' }] }] } });
  });
  it('always includes a new test absent from related graph edges', async () => {
    const input = fixture(); input.commits[0]!.changes = [{ path: 'app/test/c.test.ts', kind: 'added' }];
    expect((await replayImpactChanges(input)).rows[0]!.selection.units).toEqual([unit('app', 'app/test/a.test.ts'), unit('app', 'app/test/c.test.ts')]);
  });
  it('keeps collection failure visible as a whole-package fallback', async () => {
    const input = fixture(); input.collect = async () => { throw new Error('collector unavailable'); };
    expect((await replayImpactChanges(input)).rows[0]).toMatchObject({ selectedCount: 3, selection: { packages: [{ mode: 'whole-package', reasons: [{ code: 'graph_unavailable' }] }] } });
  });
  it('reports observed failing units omitted by selection without claiming causality', async () => {
    const input = fixture(); input.comparator = { commit: sha(100), run: 50, part: 1, status: 'failed', inventory: input.environment.inventory, failedUnits: [unit('app', 'app/test/b.test.ts')] };
    const result = await replayImpactChanges(input);
    expect(result.status).toBe('observed-misses');
    expect(result.rows[0]!.comparison).toEqual({ status: 'observed', run: 50, part: 1, missed: [unit('app', 'app/test/b.test.ts')] });
  });
  it('reports a checked full comparator with no omitted failures as observed', async () => {
    const input = fixture(); input.comparator = { commit: sha(100), run: 51, part: 1, status: 'passed', inventory: input.environment.inventory, failedUnits: [] };
    expect((await replayImpactChanges(input)).rows[0]!.comparison).toEqual({ status: 'observed', run: 51, part: 1, missed: [] });
  });
  it.each(['wrong-sha', 'incomplete', 'unknown-failure', 'contradictory-status'] as const)('does not accept comparator %s', async issue => {
    const input = fixture(); input.comparator = { commit: sha(100), run: 50, part: 1, status: 'passed', inventory: input.environment.inventory, failedUnits: [] };
    if (issue === 'wrong-sha') input.comparator.commit = sha(99);
    if (issue === 'incomplete') input.comparator.inventory = input.comparator.inventory.slice(1);
    if (issue === 'unknown-failure') { input.comparator.status = 'failed'; input.comparator.failedUnits = [unit('app', 'missing')]; }
    if (issue === 'contradictory-status') input.comparator.failedUnits = [unit('app', 'app/test/b.test.ts')];
    expect((await replayImpactChanges(input)).rows[0]!.comparison.status).toBe('unavailable');
  });
  it('keeps blocked migration checks blocked in the replay report', async () => {
    const input = fixture(); input.commits[0]!.changes = [{ path: 'app/migrations/1.sql', kind: 'added' }];
    const result = await replayImpactChanges(input);
    expect(result.status).toBe('blocked'); expect(result.rows[0]!.selection.problems).toEqual([{ code: 'migration_check_unsupported' }]);
  });
  it.each([9, 11])('refuses %s changes instead of calling it a ten-change replay', async count => {
    const input = fixture(); input.commits = Array.from({ length: count }, (_, i) => ({ ...input.commits[0]!, commit: sha(i + 1) }));
    await expect(replayImpactChanges(input)).rejects.toThrow('impact_replay_input_invalid');
  });
  it('refuses duplicate or unpinned commit identities', async () => {
    const input = fixture(); input.commits[1]!.commit = input.commits[0]!.commit;
    await expect(replayImpactChanges(input)).rejects.toThrow('impact_replay_input_invalid');
    input.candidate = 'main'; await expect(replayImpactChanges(input)).rejects.toThrow('impact_replay_input_invalid');
  });
});
