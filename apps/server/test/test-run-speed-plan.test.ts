import { describe, expect, it } from 'vitest';
import { planTestParts, type TestPartPlanInput } from '../src/modules/testruns/plan.js';
import { machinePaces, partPaces, type FileTime } from '../src/modules/testruns/plan-speed.js';

const unit = (file: string) => ({ suiteId: 'server', file, selectionUnit: file });
/* Forty files of uneven length, as the server suite has. */
const sizes = Array.from({ length: 40 }, (_, index) => 2000 + ((index * 7919) % 23) * 1000);
const units = sizes.map((_, index) => unit(`test/${index}.test.ts`));
/* home-api took 2.3 times as long as a-host for the same files in earlier runs, and each machine saw only some of them. */
const measured: FileTime[] = units.flatMap((u, index) => [
  ...(index % 3 !== 0 ? [{ computer: 'host:a-host', suiteId: u.suiteId, file: u.file, ms: sizes[index]! }] : []),
  ...(index % 3 !== 1 ? [{ computer: 'host:home-api', suiteId: u.suiteId, file: u.file, ms: sizes[index]! * 2.3 }] : []),
]);

describe('the pace of each machine from what its parts took before', () => {
  it('finds how much longer one machine takes for the same files, against the middle one', () => {
    const { paces, durations } = machinePaces(measured);
    expect(paces.get('host:home-api')! / paces.get('host:a-host')!).toBeCloseTo(2.3, 5);
    expect(durations).toHaveLength(units.length);
    const ratio = durations[0]!.ms / sizes[Number(/\d+/.exec(durations[0]!.file)![0])]!;
    for (const duration of durations) expect(duration.ms / sizes[Number(/\d+/.exec(duration.file)![0])]!).toBeCloseTo(ratio, 5);
  });

  it('gives the same answer in whatever order the times come, and ignores times that are no measurement', () => {
    const once = machinePaces(measured), again = machinePaces([...measured].reverse().concat([{ computer: 'host:a-host', suiteId: 'server', file: 'test/0.test.ts', ms: Number.NaN }]));
    expect([...again.paces]).toEqual([...once.paces]);
    expect(again.durations).toEqual(once.durations);
  });

  it('keeps a machine seen with no other at the middle pace', () => {
    const { paces } = machinePaces([...measured, { computer: 'host:mac', suiteId: 'server', file: 'test/elsewhere.test.ts', ms: 9000 }]);
    expect(paces.get('host:mac')).toBe(1);
  });
});

describe('the pace of each machine from how long its parts ran', () => {
  const sized = units.map((u, index) => ({ suiteId: u.suiteId, file: u.file, ms: sizes[index]! }));
  const work = (files: typeof units) => files.reduce((sum, u) => sum + sizes[units.indexOf(u)]!, 0);
  /* Each file took as long on both, but home-api runs fewer files at once: its parts took 2.3 times as long for as much work. */
  const parts = [
    { computer: 'host:a-host', ms: work(units.slice(0, 20)) / 4, files: units.slice(0, 20) },
    { computer: 'host:home-api', ms: (work(units.slice(20)) / 4) * 2.3, files: units.slice(20) },
    { computer: 'host:a-host', ms: work(units.slice(10, 30)) / 4, files: units.slice(10, 30) },
  ];
  it('finds how much longer a machine takes for its parts than their files take at the middle pace', () => {
    const { paces, durations } = partPaces(parts, sized);
    expect(paces.get('host:home-api')! / paces.get('host:a-host')!).toBeCloseTo(2.3, 5);
    /* At the middle pace a part takes as long as its files together. */
    const middle = paces.get('host:a-host')!, inParts = parts[0]!.ms / middle;
    expect(parts[0]!.files.reduce((sum, u) => sum + durations.find(d => d.file === u.file)!.ms, 0)).toBeCloseTo(inParts, 3);
  });
  it('counts a file no part measured at the middle size of the others', () => {
    const { paces } = partPaces([...parts, { computer: 'host:mac', ms: 10_000, files: [unit('test/new.test.ts')] }], sized);
    expect(paces.get('host:mac')).toBeGreaterThan(0);
    expect([...paces.keys()].sort()).toEqual(['host:a-host', 'host:home-api', 'host:mac']);
  });
  it('knows no pace without a part that ran', () => {
    expect(partPaces([], sized).paces.size).toBe(0);
  });
});

function input(machines: { key: string; pace: number }[]): TestPartPlanInput {
  const { durations } = machinePaces(measured);
  return { units, durations, availableMachines: machines.length, machines, costs: { setupMs: 20_000, collectMs: 1000 }, unknownFileMs: 30_000 };
}

describe('parts laid out by the pace of the machines that run them', () => {
  it('gives the faster machine more work, so that both parts end at about the same time', () => {
    const { paces } = machinePaces(measured);
    const plan = planTestParts(input([...paces].map(([key, pace]) => ({ key, pace }))));
    expect(plan.parts.map(part => part.machine?.key).sort()).toEqual(['host:a-host', 'host:home-api']);
    const fast = plan.parts.find(part => part.machine?.key === 'host:a-host')!, slow = plan.parts.find(part => part.machine?.key === 'host:home-api')!;
    expect(fast.testMs).toBeGreaterThan(2 * slow.testMs);
    const [first, second] = plan.parts.map(part => part.machine!.ms) as [number, number];
    expect(Math.abs(first - second) / Math.max(first, second)).toBeLessThan(0.1);
    expect(plan.estimatedWallMs).toBe(20_000 + Math.max(first, second) + 2 * 1000);
    expect(plan.parts.flatMap(part => part.units.map(u => u.file)).sort()).toEqual(units.map(u => u.file).sort());
  });

  it('lays parts out evenly and names no machine for them when the machines go at one pace', () => {
    const plan = planTestParts(input([{ key: 'host:one', pace: 1 }, { key: 'host:two', pace: 1.05 }]));
    expect(plan.parts).toHaveLength(2);
    expect(plan.parts.every(part => part.machine === undefined)).toBe(true);
  });

  it('runs on the fastest machine when one part is cheaper than two', () => {
    const request = input([{ key: 'host:slow', pace: 2 }, { key: 'host:fast', pace: 0.5 }]);
    const plan = planTestParts({ ...request, units: units.slice(0, 1), durations: request.durations.slice(0, 1), costs: { setupMs: 600_000, collectMs: 1000 } });
    expect(plan.parts.map(part => part.machine?.key)).toEqual(['host:fast']);
  });
});
