import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { timingLine } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { compareSnapshots, improvementCard, Snapshot, testTimings } from '../src/benchmark/report.js';

const snapshot = (coldReadyMs = 100) => ({ version: 1 as const, measuredAt: '2026-11-05T14:00:00.000Z', commit: 'c'.repeat(40), environment: { node: 'v22', platform: 'linux', arch: 'x64', cpus: 2, database: 'pglite', samples: 3 }, coldReadyMs, appReadyMs: 30, dbSetupMs: 50, memory: { rss: 1000, heapUsed: 500 }, requests: [{ method: 'GET', url: '/api/org', statusCode: 200 as const, errors: 0 as const, samples: 3, medianMs: 2, p95Ms: 3 }], tests: testTimings([]) });

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

  it('reads file/phase measurements from #308 timing lines and ranks parts by summed file time', () => {
    const file = (name: string, totalMs: number) => timingLine({ kind: 'file', package: 'apps/server', file: name, totalMs, setupMs: 10, testsMs: totalMs - 12, teardownMs: 2, slowest: [] });
    const tests = testTimings([{ name: 'part-1', log: [file('a.test.ts', 40), file('b.test.ts', 90)].join('\n') }, { name: 'part-2', log: file('c.test.ts', 200) }]);
    expect(tests.status).toBe('measured');
    expect(tests.slowestFiles.map(f => f.file)).toEqual(['c.test.ts', 'b.test.ts', 'a.test.ts']);
    expect(tests.parts.map(p => [p.name, p.totalMs])).toEqual([['part-2', 200], ['part-1', 130]]);
    expect(tests.totalMs).toBe(330);
    expect(testTimings([])).toMatchObject({ status: 'missing', totalMs: null });
  });

  it('creates a nonblocking next-turn task with before and target-after numbers, retaining unknown acceptance time', () => {
    const card = improvementCard({ turn: 7, source: '#308 retrospective, approximate', wait: 'test waits', beforeSeconds: 21600, events: 11, acceptanceSeconds: null }, 30);
    expect(card).toMatchObject({ blocking: false, before: { seconds: 21600, percentOfBaseline: 100 }, targetAfter: { percentOfBaseline: 70, reductionPercent: 30 }, acceptance: { beforeSeconds: null, targetReductionPercent: 30 } });
    expect(card.measurementBecomesTest).toBe(true);
    expect(card.text).toContain('issue-to-acceptance');
    expect(() => improvementCard({ turn: 7, source: 'fixture', wait: 'tests', beforeSeconds: 21600, events: 11, acceptanceSeconds: 100 }, 29)).toThrow();
  });
});

 it('launches the benchmark against an isolated real app and emits measured numbers', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const run = spawnSync(process.execPath, ['scripts/release-benchmark.mjs', '--samples', '3', '--commit', 'c'.repeat(40)], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  expect(run.status, run.stderr).toBe(0);
  const report = JSON.parse(run.stdout) as { snapshot: unknown; comparison: { status: string } };
  const measured = Snapshot.parse(report.snapshot);
  expect(measured.coldReadyMs).toBeGreaterThan(measured.appReadyMs);
  expect(measured.dbSetupMs).toBeGreaterThan(0);
  expect(measured.memory.rss).toBeGreaterThan(0);
  expect(measured.requests.map(r => r.url)).toEqual(['/api/me', '/api/org', '/api/tasks']);
  expect(measured.requests.every(r => r.statusCode === 200 && r.errors === 0)).toBe(true);
  expect(measured.requests.every(r => r.medianMs > 0 && r.p95Ms >= r.medianMs)).toBe(true);
  expect(report.comparison.status).toBe('baseline-missing');
 }, 40_000);
