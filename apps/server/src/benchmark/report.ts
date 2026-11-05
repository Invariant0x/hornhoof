import { parseTimingLines, TestFileTiming } from '@hornhoof/protocol';
import { z } from 'zod';

const NumberAtLeastZero = z.number().finite().nonnegative();
const Tests = z.object({
  status: z.enum(['measured', 'missing']),
  totalMs: NumberAtLeastZero.nullable(),
  parts: z.array(z.object({ name: z.string(), totalMs: NumberAtLeastZero, files: z.number().int().nonnegative() })),
  slowestFiles: z.array(TestFileTiming),
});
export const Snapshot = z.object({
  version: z.literal(1),
  measuredAt: z.iso.datetime(),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  environment: z.object({ node: z.string(), platform: z.string(), arch: z.string(), cpus: z.number().int().positive(), database: z.string(), samples: z.number().int().positive() }),
  coldReadyMs: NumberAtLeastZero,
  appReadyMs: NumberAtLeastZero,
  dbSetupMs: NumberAtLeastZero,
  memory: z.object({ rss: NumberAtLeastZero, heapUsed: NumberAtLeastZero }),
  requests: z.array(z.object({ method: z.string(), url: z.string(), statusCode: z.literal(200), errors: z.literal(0), samples: z.number().int().positive(), medianMs: NumberAtLeastZero, p95Ms: NumberAtLeastZero })).nonempty(),
  tests: Tests,
});
export type Snapshot = z.infer<typeof Snapshot>;

/* Part totals are summed file time, not elapsed wall time: parallel files overlap. */
export function testTimings(logs: { name: string; log: string }[]): z.infer<typeof Tests> {
  const parts = logs.map(part => ({ name: part.name, files: parseTimingLines(part.log).files }));
  const files = parts.flatMap(part => part.files);
  return {
    status: files.length ? 'measured' : 'missing',
    totalMs: files.length ? files.reduce((sum, file) => sum + file.totalMs, 0) : null,
    parts: parts.filter(part => part.files.length).map(part => ({ name: part.name, totalMs: part.files.reduce((sum, file) => sum + file.totalMs, 0), files: part.files.length })).sort((a, b) => b.totalMs - a.totalMs),
    slowestFiles: files.sort((a, b) => b.totalMs - a.totalMs),
  };
}

function metrics(snapshot: Snapshot): Map<string, number> {
  return new Map([
    ['coldReadyMs', snapshot.coldReadyMs], ['appReadyMs', snapshot.appReadyMs], ['dbSetupMs', snapshot.dbSetupMs],
    ['memory.rss', snapshot.memory.rss], ['memory.heapUsed', snapshot.memory.heapUsed],
    ...snapshot.requests.flatMap(r => [[`request.${r.method}.${r.url}.medianMs`, r.medianMs], [`request.${r.method}.${r.url}.p95Ms`, r.p95Ms]] as [string, number][]),
    ...snapshot.tests.totalMs === null ? [] : [['tests.totalMs', snapshot.tests.totalMs] as [string, number]],
    ...snapshot.tests.parts.map(p => [`part.${p.name}.totalMs`, p.totalMs] as [string, number]),
    ...snapshot.tests.slowestFiles.map(f => [`file.${f.package}/${f.file}.totalMs`, f.totalMs] as [string, number]),
  ]);
}

function metricDelta(metric: string, baseline: number | undefined, current: number | undefined, threshold: number) {
  if (baseline === undefined || current === undefined) return { missing: { metric, reason: 'measurement-missing' } };
  if (baseline === 0) return { missing: { metric, reason: 'zero-baseline' } };
  const deltaPercent = (current - baseline) / baseline * 100;
  return deltaPercent > threshold ? { regression: { metric, baseline, current, deltaPercent } } : {};
}

function comparisonStatus(regressions: unknown[], missing: { reason: string }[]): string {
  if (missing.some(m => m.reason === 'zero-baseline')) return 'incomparable';
  if (regressions.length) return 'regression';
  return missing.length ? 'partial' : 'ok';
}

export function compareSnapshots(current: Snapshot, previous: Snapshot | null, thresholdPercent: number) {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent <= 0) throw new Error('Regression threshold must be positive.');
  const regressions: { metric: string; baseline: number; current: number; deltaPercent: number }[] = [];
  const missing: { metric: string; reason: string }[] = [];
  if (!previous) return { status: 'baseline-missing', thresholdPercent, regressions, missing };
  if (JSON.stringify(current.environment) !== JSON.stringify(previous.environment)) return { status: 'incomparable', thresholdPercent, regressions, missing: [{ metric: 'environment', reason: 'different-environment' }] };
  const before = metrics(previous);
  const after = metrics(current);
  for (const metric of new Set([...before.keys(), ...after.keys()])) {
    const delta = metricDelta(metric, before.get(metric), after.get(metric), thresholdPercent);
    if (delta.regression) regressions.push(delta.regression);
    if (delta.missing) missing.push(delta.missing);
  }
  return { status: comparisonStatus(regressions, missing), thresholdPercent, regressions, missing };
}

export function improvementCard(baseline: { turn: number; source: string; wait: string; beforeSeconds: number; events: number; acceptanceSeconds: number | null }, reductionPercent: number) {
  if (!Number.isFinite(reductionPercent) || reductionPercent < 30 || reductionPercent >= 100) throw new Error('The first target must reduce issue-to-acceptance by at least 30%, below 100%.');
  if (!Number.isFinite(baseline.beforeSeconds) || baseline.beforeSeconds <= 0) throw new Error('A measured or explicitly approximate positive baseline is required.');
  return {
    title: `Reduce ${baseline.wait} relative to turn ${baseline.turn}`,
    blocking: false,
    source: baseline.source,
    baselineTurn: baseline.turn,
    before: { seconds: baseline.beforeSeconds, events: baseline.events, percentOfBaseline: 100 },
    targetAfter: { percentOfBaseline: 100 - reductionPercent, reductionPercent },
    acceptance: { beforeSeconds: baseline.acceptanceSeconds, targetReductionPercent: reductionPercent },
    measurementBecomesTest: true,
    text: `Next-turn task: measure and reduce ${baseline.wait}; before = ${baseline.beforeSeconds}s across ${baseline.events} waits (100% of turn ${baseline.turn}); target after <= ${100 - reductionPercent}% of baseline. Establish the final issue-to-acceptance baseline and demonstrate >= ${reductionPercent}% reduction using the same task cohort and measurement. Aggregate wait time may overlap; first submission is not acceptance. Add the repeatable before/after measurement as a regression test. This improvement never blocks the release.`,
  };
}
