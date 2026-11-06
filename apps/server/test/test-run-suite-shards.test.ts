import { describe, expect, it } from 'vitest';
import { withSuiteShards, type SelectedPart } from '../src/modules/testruns/plan-shards.js';

const selection = (suiteId: string, file: string): SelectedPart['selections'][number] => ({ kind: 'suite', suiteId, files: [file] });

describe('suite-local shard coordinates', () => {
  it('counts and numbers only the parts which contain each suite in a mixed run', () => {
    const parts = [
      { selections: [selection('vitest', 'web/a.test.ts')] },
      { selections: [selection('pytest', 'python/test_a.py')] },
      { selections: [selection('vitest', 'web/b.test.ts'), selection('pytest', 'python/test_b.py')] },
    ];
    const result = withSuiteShards(parts);
    expect(result.map(part => part.suiteShards)).toEqual([
      [{ suiteId: 'vitest', index: 1, count: 2 }],
      [{ suiteId: 'pytest', index: 1, count: 2 }],
      [{ suiteId: 'vitest', index: 2, count: 2 }, { suiteId: 'pytest', index: 2, count: 2 }],
    ]);
    expect(result.map(part => part.selections)).toEqual(parts.map(part => part.selections));
    expect(parts.every(part => !('suiteShards' in part))).toBe(true);
  });
  it('assigns one local shard to each suite in a single batch part', () => {
    expect(withSuiteShards([{ selections: [selection('vitest', 'web/a.test.ts'), selection('pytest', 'python/test_a.py')] }])[0]!.suiteShards).toEqual([
      { suiteId: 'vitest', index: 1, count: 1 }, { suiteId: 'pytest', index: 1, count: 1 },
    ]);
  });
  it('keeps an indivisible suite at one shard despite several other logical parts', () => {
    const result = withSuiteShards([
      { selections: [selection('package', 'package/first.test.ts')] },
      { selections: [selection('vitest', 'web/a.test.ts')] },
      { selections: [selection('vitest', 'web/b.test.ts')] },
    ]);
    expect(result[0]!.suiteShards).toEqual([{ suiteId: 'package', index: 1, count: 1 }]);
    expect(result[2]!.suiteShards).toEqual([{ suiteId: 'vitest', index: 2, count: 2 }]);
  });
  it('refuses post-suite final checks instead of sharding them as test files', () => {
    expect(() => withSuiteShards([{ selections: [{ kind: 'final', suiteId: 'vitest', files: [] }] }])).toThrow(/suite selection/);
  });
  it('refuses duplicate suite entries within a part instead of inventing another ordinal', () => {
    expect(() => withSuiteShards([{ selections: [selection('vitest', 'web/a.test.ts'), selection('vitest', 'web/b.test.ts')] }])).toThrow(/duplicate/);
  });
  it('refuses an empty plan', () => {
    expect(() => withSuiteShards([])).toThrow(/nonempty/);
  });
  it('refuses an empty logical part', () => {
    expect(() => withSuiteShards([{ selections: [] }])).toThrow(/nonempty/);
  });
  it('refuses a suite without files instead of enabling broad discovery', () => {
    expect(() => withSuiteShards([{ selections: [{ kind: 'suite', suiteId: 'vitest', files: [] }] }])).toThrow(/nonempty/);
  });
});
