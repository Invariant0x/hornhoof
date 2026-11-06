import { describe, expect, it } from 'vitest';
import { planningHistory, type PlanningHistoryInput, type PlanningHistoryPart } from '../src/modules/testruns/plan-history.js';

const scope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryId: '33333333-3333-4333-8333-333333333333',
  manifestHash: 'a'.repeat(64), profile: 'fast' };
const timing = (ms = 10, file = 'test/a.test.ts', packageName = 'web') => ({ package: packageName, file,
  totalMs: ms, setupMs: 0, testsMs: ms, teardownMs: 0, slowest: [] });
function part(partId = 'part-1'): PlanningHistoryPart {
  return { scope: { ...scope }, runId: 'run-1', partId, status: 'passed', suiteId: 'vitest', files: [timing()], setupMs: 100, collectMs: 20 };
}
function input(parts: PlanningHistoryPart[] = [part()]): PlanningHistoryInput {
  return { scope, inventory: [{ suiteId: 'vitest', file: 'web/test/a.test.ts', selectionUnit: 'web/test/a.test.ts' }],
    suiteWorkingDirectories: { vitest: 'web' }, parts, fallbackCosts: { setupMs: 1000, collectMs: 200 } };
}

describe('scoped test planning history', () => {
  it('maps historical package-relative file times to the canonical suite inventory', () => {
    const result = planningHistory(input());
    expect(result.durations).toEqual([{ suiteId: 'vitest', file: 'web/test/a.test.ts', ms: 10 }]);
    expect(result.costs).toEqual({ setupMs: 100, collectMs: 20 });
    expect(result.costBasis).toEqual({ setup: 'historical', collection: 'historical' });
    expect(result.usedPartIds).toEqual(['part-1']);
  });

  it.each(['companyId', 'repositoryId', 'manifestHash', 'profile'] as const)('does not borrow measurements from another %s', field => {
    const record = part(); record.scope[field] = 'foreign';
    const result = planningHistory(input([record]));
    expect(result.durations).toEqual([]);
    expect(result.usedPartIds).toEqual([]);
    expect(result.costBasis).toEqual({ setup: 'fallback', collection: 'fallback' });
  });

  it.each(['queued', 'running', 'failed', 'stopped'] as const)('does not treat a %s part as completed timing evidence', status => {
    const record = part(); record.status = status;
    expect(planningHistory(input([record])).durations).toEqual([]);
  });

  it('takes setup and collection medians independently of test duration', () => {
    const a = part(), b = part('part-2'); b.setupMs = 300; b.collectMs = 40; b.files = [timing(30)];
    const result = planningHistory(input([b, a]));
    expect(result.costs).toEqual({ setupMs: 200, collectMs: 30 });
    expect(result.durations.map(value => value.ms)).toEqual([10, 30]);
    expect(result.usedPartIds).toEqual(['part-1', 'part-2']);
  });

  it('does not count the same persisted part twice', () => {
    const record = part();
    const result = planningHistory(input([record, record]));
    expect(result.durations).toHaveLength(1);
    expect(result.usedPartIds).toEqual(['part-1']);
  });

  it('does not include a historical file absent from the current inventory', () => {
    const record = part(); record.files.push(timing(100, 'test/removed.test.ts'));
    const result = planningHistory(input([record]));
    expect(result.durations).toEqual([{ suiteId: 'vitest', file: 'web/test/a.test.ts', ms: 10 }]);
    expect(result.unmatchedFiles).toBe(1);
  });

  it('uses a known suite working directory when an older root reporter printed only a relative filename', () => {
    const record = part(); record.files = [timing(12, 'test/a.test.ts', '.')];
    expect(planningHistory(input([record])).durations).toEqual([{ suiteId: 'vitest', file: 'web/test/a.test.ts', ms: 12 }]);
  });

  it('does not invent a suite for an ambiguous legacy timing', () => {
    const record = part(); record.suiteId = null;
    const request = input([record]); request.inventory.push({ ...request.inventory[0]!, suiteId: 'other' });
    const result = planningHistory(request);
    expect(result.durations).toEqual([]);
    expect(result.unmatchedFiles).toBe(1);
  });

  it('uses the receipt suite to distinguish two suites that run the same file', () => {
    const request = input(); request.inventory.push({ ...request.inventory[0]!, suiteId: 'other' });
    expect(planningHistory(request).durations).toEqual([{ suiteId: 'vitest', file: 'web/test/a.test.ts', ms: 10 }]);
  });

  it('rejects escaping historical paths instead of normalizing them into a different file', () => {
    const record = part(); record.files = [timing(12, '../web/test/a.test.ts', 'web')];
    const result = planningHistory(input([record]));
    expect(result.durations).toEqual([]);
    expect(result.unmatchedFiles).toBe(1);
  });

  it('retains genuine zero times while excluding malformed duration and cost samples', () => {
    const record = part(); record.files = [timing(0), timing(Number.NaN), timing(-1), timing(Infinity)];
    record.setupMs = Number.NaN; record.collectMs = -1;
    const result = planningHistory(input([record]));
    expect(result.durations).toEqual([{ suiteId: 'vitest', file: 'web/test/a.test.ts', ms: 0 }]);
    expect(result.costs).toEqual({ setupMs: 1000, collectMs: 200 });
    expect(result.costBasis).toEqual({ setup: 'fallback', collection: 'fallback' });
    expect(result.unmatchedFiles).toBe(3);
  });

  it('preserves explicit fallback costs when there is no eligible history', () => {
    const result = planningHistory(input([]));
    expect(result.durations).toEqual([]);
    expect(result.costs).toEqual({ setupMs: 1000, collectMs: 200 });
    expect(result.costBasis).toEqual({ setup: 'fallback', collection: 'fallback' });
  });

  it('does not label a missing collection observation as a measured zero', () => {
    const record = part(); record.collectMs = null;
    const result = planningHistory(input([record]));
    expect(result.costs).toEqual({ setupMs: 100, collectMs: 200 });
    expect(result.costBasis).toEqual({ setup: 'historical', collection: 'fallback' });
  });
});
