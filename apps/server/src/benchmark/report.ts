import { SLOWEST_TESTS, TestFileTiming, type TestFileTiming as FileTiming } from '@hornhoof/protocol';
import { timingsOfLog } from '../modules/testruns/timings.js';
import { z } from 'zod';

const NumberAtLeastZero = z.number().finite().nonnegative();
const Tests = z.object({
  status: z.enum(['measured', 'partial', 'missing']),
  totalMs: NumberAtLeastZero.nullable(),
  parts: z.array(z.object({ name: z.string(), totalMs: NumberAtLeastZero.nullable(), files: z.number().int().nonnegative() })),
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

const sumPhase = (a: number | null, b: number | null): number | null => a === null || b === null ? null : a + b;

function summedFiles(files: FileTiming[]): FileTiming[] {
  const totals = new Map<string, FileTiming>();
  for (const file of files) {
    const key = `${file.package}/${file.file}`;
    const previous = totals.get(key);
    if (!previous) { totals.set(key, file); continue; }
    totals.set(key, { ...file, totalMs: previous.totalMs + file.totalMs, setupMs: sumPhase(previous.setupMs, file.setupMs), testsMs: sumPhase(previous.testsMs, file.testsMs), teardownMs: sumPhase(previous.teardownMs, file.teardownMs), slowest: [...previous.slowest, ...file.slowest].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST_TESTS) });
  }
  return [...totals.values()];
}

/* Part totals are summed file time, not elapsed wall time: parallel files overlap. */
export function testTimings(logs: { name: string; log: string }[]): z.infer<typeof Tests> {
  const parts = logs.map(part => ({ name: part.name, files: timingsOfLog(part.log).files }));
  const files = parts.flatMap(part => part.files);
  const complete = parts.every(part => part.files.length > 0);
  return {
    status: files.length ? complete ? 'measured' : 'partial' : 'missing',
    totalMs: complete && files.length ? files.reduce((sum, file) => sum + file.totalMs, 0) : null,
    parts: parts.map(part => ({ name: part.name, totalMs: part.files.length ? part.files.reduce((sum, file) => sum + file.totalMs, 0) : null, files: part.files.length })).sort((a, b) => (b.totalMs ?? -1) - (a.totalMs ?? -1)),
    slowestFiles: summedFiles(files).sort((a, b) => b.totalMs - a.totalMs),
  };
}

function metrics(snapshot: Snapshot): Map<string, number | null> {
  return new Map([
    ['coldReadyMs', snapshot.coldReadyMs], ['appReadyMs', snapshot.appReadyMs], ['dbSetupMs', snapshot.dbSetupMs],
    ['memory.rss', snapshot.memory.rss], ['memory.heapUsed', snapshot.memory.heapUsed],
    ...snapshot.requests.flatMap(r => [[`request.${r.method}.${r.url}.medianMs`, r.medianMs], [`request.${r.method}.${r.url}.p95Ms`, r.p95Ms]] as [string, number][]),
    ['tests.totalMs', snapshot.tests.totalMs],
    ...snapshot.tests.parts.map(p => [`part.${p.name}.totalMs`, p.totalMs] as [string, number | null]),
    ...snapshot.tests.slowestFiles.map(f => [`file.${f.package}/${f.file}.totalMs`, f.totalMs] as [string, number]),
  ]);
}

function metricDelta(metric: string, baseline: number | null | undefined, current: number | null | undefined, threshold: number) {
  if (baseline == null || current == null) return { missing: { metric, reason: 'measurement-missing' } };
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

export function requestStats(samples: readonly number[]): { medianMs: number; p95Ms: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const medianMs = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { medianMs, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]! };
}
