import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { timingLine } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { compareSnapshots, requestStats, Snapshot, testTimings } from '../src/benchmark/report.js';

const snapshot = (coldReadyMs = 100) => ({ version: 1 as const, measuredAt: '2026-11-05T14:00:00.000Z', commit: 'c'.repeat(40), environment: { node: 'v22', platform: 'linux', arch: 'x64', cpus: 2, database: 'pglite', samples: 3 }, coldReadyMs, appReadyMs: 30, dbSetupMs: 50, memory: { rss: 1000, heapUsed: 500 }, requests: [{ method: 'GET', url: '/api/org', statusCode: 200 as const, errors: 0 as const, samples: 3, medianMs: 2, p95Ms: 3 }], tests: testTimings([{ name: 'part-1', log: timingLine({ kind: 'file', package: 'fixture', file: 'a.test.ts', totalMs: 1, setupMs: 0, testsMs: 1, teardownMs: 0, slowest: [] }) }]) });

describe('release benchmark report', () => {
  it('validates finite structured measurements instead of accepting missing or invalid numbers', () => {
    expect(Snapshot.parse(snapshot())).toMatchObject({ coldReadyMs: 100, memory: { rss: 1000, heapUsed: 500 } });
    expect(() => Snapshot.parse({ ...snapshot(), coldReadyMs: NaN })).toThrow();
    expect(() => Snapshot.parse({ ...snapshot(), requests: [] })).toThrow();
    expect(() => Snapshot.parse({ ...snapshot(), requests: [{ ...snapshot().requests[0], statusCode: 500, errors: 1 }] })).toThrow();
  });

  it('detects synthetic regressions against the previous release and names missing comparisons', () => {
    const previous = snapshot();
    const current = { ...snapshot(140), memory: { rss: 1500, heapUsed: 500 } };
    expect(compareSnapshots(current, previous, 20)).toMatchObject({ status: 'regression', regressions: expect.arrayContaining([expect.objectContaining({ metric: 'coldReadyMs', deltaPercent: 40 }), expect.objectContaining({ metric: 'memory.rss', deltaPercent: 50 })]) });
    expect(compareSnapshots(previous, previous, 20).status).toBe('ok');
    expect(compareSnapshots(snapshot(120), previous, 20).status).toBe('ok');
    expect(compareSnapshots(previous, { ...previous, coldReadyMs: 0 }, 20)).toMatchObject({ status: 'incomparable', missing: [{ metric: 'coldReadyMs', reason: 'zero-baseline' }] });
    expect(compareSnapshots(current, null, 20).status).toBe('baseline-missing');
    expect(compareSnapshots(current, { ...previous, environment: { ...previous.environment, database: 'postgres' } }, 20).status).toBe('incomparable');
  });

  it('reads file/phase measurements from structured timing lines and ranks parts by summed file time', () => {
    const file = (name: string, totalMs: number) => timingLine({ kind: 'file', package: 'apps/server', file: name, totalMs, setupMs: 10, testsMs: totalMs - 12, teardownMs: 2, slowest: [] });
    const tests = testTimings([{ name: 'part-1', log: [file('a.test.ts', 40), file('b.test.ts', 90)].join('\n') }, { name: 'part-2', log: file('c.test.ts', 200) }]);
    expect(tests.status).toBe('measured');
    expect(tests.slowestFiles.map(f => f.file)).toEqual(['c.test.ts', 'b.test.ts', 'a.test.ts']);
    expect(tests.parts.map(p => [p.name, p.totalMs])).toEqual([['part-2', 200], ['part-1', 130]]);
    expect(tests.totalMs).toBe(330);
    expect(testTimings([])).toMatchObject({ status: 'missing', totalMs: null });
  });
});

 it('launches the benchmark against an isolated real app and emits measured numbers', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  /* The benchmark ends by itself: the test waits for it to close, and only the test's own limit ends one that hangs. */
  const run = spawn(process.execPath, ['scripts/release-benchmark.mjs', '--samples', '3', '--commit', 'c'.repeat(40)], { cwd: root });
  onTestFinished(() => { run.kill(); });
  let stdout = '';
  let stderr = '';
  run.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  run.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const [status] = (await once(run, 'close')) as [number | null];
  expect(status, stderr).toBe(0);
  const report = JSON.parse(stdout) as { snapshot: unknown; comparison: { status: string } };
  const measured = Snapshot.parse(report.snapshot);
  expect(measured.coldReadyMs).toBeGreaterThan(measured.appReadyMs);
  expect(measured.dbSetupMs).toBeGreaterThan(0);
  expect(measured.memory.rss).toBeGreaterThan(0);
  expect(measured.requests.map(r => r.url)).toEqual(['/api/me', '/api/org', '/api/tasks?department=none']);
  expect(measured.requests.every(r => r.statusCode === 200 && r.errors === 0)).toBe(true);
  expect(measured.requests.every(r => r.medianMs > 0 && r.p95Ms >= r.medianMs)).toBe(true);
  expect(report.comparison.status).toBe('baseline-missing');
 }, 40_000);

it('uses legacy runner logs when structured lines are absent and sums a file seen in two parts', () => {
  const a = ' RUN v5.0.5 /data/tests/one/repo/apps/server\n ✓ test/a.test.ts (1 test) 100ms';
  const b = ' RUN v5.0.5 /data/tests/one/repo/apps/server\n ✓ test/a.test.ts (1 test) 200ms';
  const timings = testTimings([{ name: 'part-1', log: a }, { name: 'part-2', log: b }]);
  expect(timings.status).toBe('measured');
  expect(timings.totalMs).toBe(300);
  expect(timings.slowestFiles).toHaveLength(1);
  expect(timings.slowestFiles[0]).toMatchObject({ file: 'test/a.test.ts', totalMs: 300, setupMs: null });
});

it('keeps missing test measurements unknown even when both snapshots and an input part lack timings', () => {
  const missing = { ...snapshot(), tests: testTimings([]) };
  expect(compareSnapshots(missing, missing, 20)).toMatchObject({ status: 'partial', missing: [{ metric: 'tests.totalMs', reason: 'measurement-missing' }] });
  const partial = testTimings([{ name: 'unreported-part', log: 'runner output without timing data' }]);
  expect(partial.parts).toEqual([{ name: 'unreported-part', totalMs: null, files: 0 }]);
  expect(compareSnapshots({ ...snapshot(), tests: partial }, { ...snapshot(), tests: partial }, 20).missing).toContainEqual({ metric: 'part.unreported-part.totalMs', reason: 'measurement-missing' });
});

it('uses the median of both middle observations for even request samples', () => {
  const samples = [9, 1, 7, 3];
  expect(requestStats(samples)).toEqual({ medianMs: 5, p95Ms: 9 });
  expect(samples).toEqual([9, 1, 7, 3]);
  expect(requestStats([9, 1, 5])).toEqual({ medianMs: 5, p95Ms: 9 });
});
