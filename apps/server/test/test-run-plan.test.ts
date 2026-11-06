import { describe, expect, it } from 'vitest';
import { planTestParts, type TestPartPlanInput } from '../src/modules/testruns/plan.js';

const unit = (file: string, suiteId = 'server', selectionUnit = file) => ({ suiteId, file, selectionUnit });
function input(times: number[], availableMachines = 4): TestPartPlanInput {
  const units = times.map((_, index) => unit(`test/${index}.test.ts`));
  return { units, durations: units.map((u, index) => ({ suiteId: u.suiteId, file: u.file, ms: times[index]! })),
    availableMachines, costs: { setupMs: 1000, collectMs: 100 }, unknownFileMs: 5000 };
}
const selected = (plan: ReturnType<typeof planTestParts>) => plan.parts.flatMap(part => part.units.map(u => `${u.suiteId}:${u.file}`)).sort();

describe('historical test part planning', () => {
  it('keeps a small run together when preparing extra machines costs more', () => {
    const plan = planTestParts(input([10, 20, 30, 40]));
    expect(plan.parts).toHaveLength(1);
    expect(plan.oneMachineMs).toBe(1200);
    expect(plan.reason).toContain('cost');
    expect(plan.alternatives.every(option => option.costAdjustedMs >= plan.costAdjustedMs)).toBe(true);
  });

  it('splits a large run across free machines and records the saving estimate', () => {
    const plan = planTestParts(input([20_000, 20_000, 20_000, 20_000]));
    expect(plan.parts).toHaveLength(4);
    expect(plan.oneMachineMs).toBe(81_100);
    expect(plan.estimatedWallMs).toBe(21_400);
    expect(plan.costAdjustedMs).toBe(24_400);
    expect(plan.reason).toContain('4');
    expect(plan.reason).toContain('81100');
    expect(plan.unknownUnits).toEqual([]);
  });

  it('uses fewer parts when compatible free capacity falls', () => {
    expect(planTestParts(input(Array(8).fill(30_000), 2)).parts).toHaveLength(2);
    expect(planTestParts(input(Array(8).fill(30_000), 1)).parts).toHaveLength(1);
  });

  it('queues one part when there is no compatible free machine', () => {
    const plan = planTestParts(input([50_000, 50_000], 0));
    expect(plan.parts).toHaveLength(1);
    expect(plan.waitingForCapacity).toBe(true);
    expect(plan.reason).toContain('No compatible machine is free');
  });

  it('balances uneven historical file times instead of file counts', () => {
    const request = input([6000, 3000, 1000, 1000, 1000], 2);
    const plan = planTestParts(request);
    expect(plan.parts.map(part => part.testMs)).toEqual([6000, 6000]);
    expect(plan.parts.map(part => part.units.length).sort()).toEqual([1, 4]);
    expect(selected(plan)).toEqual(request.units.map(u => `${u.suiteId}:${u.file}`).sort());
  });

  it('never exceeds ten parts even with more free machines', () => {
    expect(planTestParts(input(Array(40).fill(100_000), 40)).parts).toHaveLength(10);
  });

  it('charges setup and collection for additional machines and prefers fewer parts on ties', () => {
    const request = input([1000, 1000], 2);
    request.costs = { setupMs: 900, collectMs: 100 };
    const plan = planTestParts(request);
    expect(plan.parts).toHaveLength(1);
    expect(plan.alternatives.map(option => option.costAdjustedMs)).toEqual([3000, 3000]);
  });

  it('marks unknown times and keeps every file in a deterministic fallback order', () => {
    const request = input([1000, 2000, 3000], 2);
    request.durations = [];
    const plan = planTestParts(request);
    const reversed = planTestParts({ ...request, units: [...request.units].reverse() });
    expect(plan.unknownUnits).toEqual(request.units);
    expect(plan.parts).toEqual(reversed.parts);
    expect(plan.reason).toContain('estimated');
    expect(selected(plan)).toHaveLength(3);
  });

  it('uses the median of available observations and retains genuine zero durations', () => {
    const request = input([0, 10], 1);
    request.durations.push({ suiteId: 'server', file: 'test/1.test.ts', ms: 1000 }, { suiteId: 'server', file: 'test/1.test.ts', ms: 30 });
    const plan = planTestParts(request);
    expect(plan.parts[0]!.testMs).toBe(30);
    expect(plan.unknownUnits).toEqual([]);
  });

  it('does not borrow a timing from another suite with the same filename', () => {
    const request = input([1000], 1);
    request.units = [unit('test/0.test.ts', 'python')];
    const plan = planTestParts(request);
    expect(plan.parts[0]!.testMs).toBe(5000);
    expect(plan.unknownUnits).toEqual(request.units);
  });

  it('keeps a shared selection unit indivisible and distinguishes suites', () => {
    const request = input([30_000, 30_000, 30_000, 30_000]);
    request.units = request.units.map((u, index) => ({ ...u, selectionUnit: index < 2 ? 'package-a' : 'package-b' }));
    const plan = planTestParts(request);
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts.map(part => new Set(part.units.map(u => u.selectionUnit)).size)).toEqual([1, 1]);
    expect(selected(plan)).toHaveLength(4);
  });

  it('treats malformed historical measurements as unknown without changing the selection', () => {
    const request = input([Number.NaN, -10, Infinity], 1);
    const plan = planTestParts(request);
    expect(plan.parts[0]!.testMs).toBe(15_000);
    expect(plan.unknownUnits).toEqual(request.units);
  });

  it('rejects duplicate selected tests instead of silently dropping or running them twice', () => {
    const request = input([1000]);
    request.units.push(request.units[0]!);
    expect(() => planTestParts(request)).toThrow(/duplicate/i);
  });

  it('rejects an empty test selection', () => {
    expect(() => planTestParts(input([]))).toThrow(/empty/i);
  });

  it.each([-1, 1.5, Number.NaN, Infinity])('rejects invalid capacity %s', availableMachines => {
    expect(() => planTestParts(input([10], availableMachines))).toThrow(/capacity/i);
  });

  it.each([-1, Number.NaN, Infinity])('rejects invalid setup or collection cost %s', value => {
    expect(() => planTestParts({ ...input([10]), costs: { setupMs: value, collectMs: 0 } })).toThrow(/cost/i);
    expect(() => planTestParts({ ...input([10]), costs: { setupMs: 0, collectMs: value } })).toThrow(/cost/i);
  });

  it('rejects a missing-file estimate that cannot bound unknown files', () => {
    expect(() => planTestParts({ ...input([10]), unknownFileMs: 0 })).toThrow(/estimate/i);
  });
});
