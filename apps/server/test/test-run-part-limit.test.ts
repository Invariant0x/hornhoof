import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { planTestParts, type TestPartPlan, type TestPartPlanInput } from '../src/modules/testruns/plan.js';
import { partTimes } from '../src/modules/testruns/plan-measured.js';
import { partSpread } from '../src/modules/testruns/plan-product.js';

/* What each file of the one batch of run 109 took on home-api, in the time of its part: the wall time of each suite as the log printed
   it, shared out by what each of its files took there. Mutation and the release scripts printed no time of their files, so they share
   the rest of the part's command time. The part had every file of the release and ran into its limit of 90 minutes. */
type Table = { commandMs: number; setupMs: number; files: Record<string, Record<string, number>> };
const table = JSON.parse(readFileSync(new URL('./fixtures/part-times-run-109.json', import.meta.url), 'utf8')) as Table;
const MINUTE = 60_000;
const units = Object.entries(table.files).flatMap(([suiteId, files]) => Object.keys(files).map(file => ({ suiteId, file, selectionUnit: file })));
const durations = Object.entries(table.files).flatMap(([suiteId, files]) => Object.entries(files).map(([file, ms]) => ({ suiteId, file, ms })));

function run109(limitMinutes: number, full: boolean, availableMachines = 1): TestPartPlanInput {
  return { units, durations, availableMachines, costs: { setupMs: table.setupMs, collectMs: 1000 }, unknownFileMs: 30_000, ...partSpread(full, limitMinutes * MINUTE) };
}
/* How long a part should take on the machine it goes to, with its setup. */
const partMs = (part: TestPartPlan['parts'][number]): number => table.setupMs + (part.machine?.ms ?? part.testMs);
const planned = (plan: TestPartPlan) => plan.parts.flatMap(part => part.units.map(unit => `${unit.suiteId}:${unit.file}`)).sort();
const all = units.map(unit => `${unit.suiteId}:${unit.file}`).sort();

describe('the parts of a run of the whole release, by what its files took in run 109', () => {
  it('holds the time the part of run 109 ran, file by file', () => {
    /* Each file's time is rounded to the millisecond. */
    expect(Math.abs(durations.reduce((sum, duration) => sum + duration.ms, 0) - table.commandMs)).toBeLessThanOrEqual(units.length / 2);
    expect(units).toHaveLength(1181);
  });

  it.each([
    ['a run that takes only what its release proved, with 90 minutes a part, as 109 had', 90, false],
    ['a run that takes only what its release proved, with the default 30 minutes', 30, false],
    ['the first run of a release, with its hour a part', 60, true],
  ])('%s keeps every part within three quarters of its limit on the one free machine', (_name, limit, full) => {
    const plan = planTestParts(run109(limit, full));
    expect(plan.parts.map(partMs).filter(ms => ms > 0.75 * limit * MINUTE)).toEqual([]);
    expect(plan.parts.length).toBeGreaterThan(1);
    expect(planned(plan)).toEqual(all);
  });

  it('runs the parts at once on several free machines, each within three quarters of its limit', () => {
    const plan = planTestParts(run109(30, false, 3)), one = planTestParts(run109(30, false, 1));
    expect(plan.parts.map(partMs).filter(ms => ms > 0.75 * 30 * MINUTE)).toEqual([]);
    expect(plan.estimatedWallMs).toBeLessThan(one.estimatedWallMs / 2);
    expect(planned(plan)).toEqual(all);
  });

  it('keeps a run that fits in one part in one part', () => {
    const plan = planTestParts({ ...run109(30, false), units: units.filter(unit => unit.suiteId === 'node') });
    expect(plan.parts).toHaveLength(1);
  });
});

/* When no count of parts keeps each within three quarters of the limit, the run takes the count whose longest part is shortest:
   every part may still run into its limit, but the fewest files with it. */
describe('a run that no count of parts fits', () => {
  it('takes as many parts as its budget when even that many run past three quarters of the limit, and loses no file', () => {
    /* At 5 minutes a part, ten parts of the 90 minutes of 109 would still take 9 each. */
    const plan = planTestParts(run109(5, false));
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

/* Run 109's part ran 90 minutes and was stopped before its last files: what it ran in that time is less than all its files take. */
describe('the pace of a machine, from parts that ran all their files', () => {
  const row = (error: string | null) => ({ computer: 'host:home-api', files: [], error,
    receipt: { phases: { commandMs: table.commandMs } }, selection: { selection: { kind: 'batch', selections: [{ suiteId: 'web', files: ['apps/web/test/a.test.ts'] }] } } }) as unknown as Parameters<typeof partTimes>[0][number];

  it('takes the time of a part that passed or whose tests failed', () => {
    expect(partTimes([row(null), row('failed')]).map(part => part.ms)).toEqual([table.commandMs, table.commandMs]);
  });
  it.each(['timeout', 'cancelled', 'prerequisite_failed', 'machine_offline'])('takes no time of a part that ended by %s', error => {
    expect(partTimes([row(error)])).toEqual([]);
  });
});
