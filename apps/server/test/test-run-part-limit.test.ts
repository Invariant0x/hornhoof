import { describe, expect, it } from 'vitest';
import { planTestParts, type TestPartPlan, type TestPartPlanInput } from '../src/modules/testruns/plan.js';
import { partTimes } from '../src/modules/testruns/plan-measured.js';
import { partSpread } from '../src/modules/testruns/plan-product.js';

/* A synthetic release with suites of different sizes and costs. Each suite's time is spread over its files. */
const MINUTE = 60_000;
const setupMs = 6500;
const commandMs = 90 * MINUTE;
const workloads = {
  browser: [128, 960_000],
  'browser-matrix': [128, 1_890_000],
  mutation: [7, 73_000],
  node: [167, 65_000],
  'release-scripts': [19, 198_000],
  server: [572, 2_007_000],
  'server-postgres': [13, 17_000],
  'server-slow': [3, 25_000],
  web: [144, 165_000],
} as const;
const durations = Object.entries(workloads).flatMap(([suiteId, [count, total]]) =>
  Array.from({ length: count }, (_, index) => ({
    suiteId, file: `test/file-${index + 1}.test.ts`, ms: Math.floor((index + 1) * total / count) - Math.floor(index * total / count),
  })));
const units = durations.map(({ suiteId, file }) => ({ suiteId, file, selectionUnit: file }));

function releasePlan(limitMinutes: number, full: boolean, availableMachines = 1): TestPartPlanInput {
  return { units, durations, availableMachines, costs: { setupMs, collectMs: 1000 }, unknownFileMs: 30_000, ...partSpread(full, limitMinutes * MINUTE) };
}
/* How long a part should take on the machine it goes to, with its setup. */
const partMs = (part: TestPartPlan['parts'][number]): number => setupMs + (part.machine?.ms ?? part.testMs);
const planned = (plan: TestPartPlan) => plan.parts.flatMap(part => part.units.map(unit => `${unit.suiteId}:${unit.file}`)).sort();
const all = units.map(unit => `${unit.suiteId}:${unit.file}`).sort();

describe('parts of a large release', () => {
  it.each([
    ['a run that takes only what its release proved, with 90 minutes a part', 90, false],
    ['a run that takes only what its release proved, with the default 30 minutes', 30, false],
    ['the first run of a release, with its hour a part', 60, true],
  ])('%s keeps every part within three quarters of its limit on the one free machine', (_name, limit, full) => {
    const plan = planTestParts(releasePlan(limit, full));
    expect(plan.parts.map(partMs).filter(ms => ms > 0.75 * limit * MINUTE)).toEqual([]);
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(planned(plan)).toEqual(all);
  });

  it('runs the parts at once on several free machines, each within three quarters of its limit', () => {
    const plan = planTestParts(releasePlan(30, false, 3)), one = planTestParts(releasePlan(30, false, 1));
    expect(plan.parts.map(partMs).filter(ms => ms > 0.75 * 30 * MINUTE)).toEqual([]);
    expect(plan.estimatedWallMs).toBeLessThan(one.estimatedWallMs / 2);
    expect(planned(plan)).toEqual(all);
  });

  it('keeps a run that fits in one part in one part', () => {
    const plan = planTestParts({ ...releasePlan(30, false), units: units.filter(unit => unit.suiteId === 'node') });
    expect(plan.parts).toHaveLength(1);
  });
});

/* When no count of parts keeps each within three quarters of the limit, the run takes the count whose longest part is shortest:
   every part may still run into its limit, but the fewest files with it. */
describe('a run that no count of parts fits', () => {
  it('takes as many parts as its budget when even that many run past three quarters of the limit, and loses no file', () => {
    /* At 5 minutes a part, ten parts of the 90-minute suite would still take 9 each. */
    const plan = planTestParts(releasePlan(5, false));
    expect(plan.parts).toHaveLength(10);
    expect(Math.min(...plan.parts.map(partMs))).toBeGreaterThan(0.75 * 5 * MINUTE);
    expect(plan.reason).toContain('no count fits');
    expect(planned(plan)).toEqual(all);
  });

  it('gives each of three files no part measured a part of its own when its limit is shorter than the estimate of one', () => {
    const three = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'].map(file => ({ suiteId: 'server', file, selectionUnit: file }));
    const plan = planTestParts({ units: three, durations: [], availableMachines: 1, costs: { setupMs: 10_000, collectMs: 1000 }, unknownFileMs: 30_000, ...partSpread(false, 10_000) });
    expect(plan.parts.map(part => part.units.map(unit => unit.file))).toEqual([['test/a.test.ts'], ['test/b.test.ts'], ['test/c.test.ts']]);
    expect(plan.parts.map(part => part.testMs)).toEqual([30_000, 30_000, 30_000]);
    expect(plan.unknownUnits).toEqual(three);
    expect(plan.reason).toContain('no count fits');
  });
});

describe('the pace of a machine, from parts that ran all their files', () => {
  const row = (error: string | null) => ({ computer: 'host:test-server', files: [], error,
    receipt: { phases: { commandMs: commandMs } }, selection: { selection: { kind: 'batch', selections: [{ suiteId: 'web', files: ['apps/web/test/a.test.ts'] }] } } }) as unknown as Parameters<typeof partTimes>[0][number];

  it('takes the time of a part that passed or whose tests failed', () => {
    expect(partTimes([row(null), row('failed')]).map(part => part.ms)).toEqual([commandMs, commandMs]);
  });
  it.each(['timeout', 'cancelled', 'prerequisite_failed', 'machine_offline'])('takes no time of a part that ended by %s', error => {
    expect(partTimes([row(error)])).toEqual([]);
  });
});
