import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { TestCase, TestModule, Vitest } from 'vitest/node';
import { parseTimingLines, SLOWEST_TESTS } from '../src/pipeline-report.js';
import TestTimings, { fileTiming, median, packageTiming, repositoryOf } from '../src/test-timings-reporter.js';

const aTest = (fullName: string, duration: number | null, meta: Record<string, number> = {}) =>
  ({ fullName, diagnostic: () => (duration === null ? undefined : { duration }), meta: () => meta }) as unknown as TestCase;
const aFile = (tests: TestCase[], times: { duration?: number; relativeModuleId?: string } = {}) =>
  ({
    relativeModuleId: times.relativeModuleId ?? 'test/a.test.ts',
    children: { allTests: () => tests },
    diagnostic: () => ({ environmentSetupDuration: 5, prepareDuration: 10, collectDuration: 20, setupDuration: 15, duration: times.duration ?? 100 }),
  }) as unknown as TestModule;

describe('median', () => {
  it.each([[[1, 2, 3], 2], [[1, 2, 3, 4], 2.5], [[7], 7], [[], 0]])('of %j is %d', (values, middle) => {
    expect(median(values)).toBe(middle);
  });
});

describe('repositoryOf', () => {
  it('finds the folder with .git above a package', async () => {
    const top = await mkdtemp(join(tmpdir(), 'timings-'));
    onTestFinished(() => rm(top, { recursive: true, force: true }));
    await mkdir(join(top, '.git'));
    await mkdir(join(top, 'apps/server'), { recursive: true });
    expect(repositoryOf(join(top, 'apps/server'))).toBe(top);
    expect(repositoryOf(top)).toBe(top);
  });

  it('keeps the folder itself outside any repository', async () => {
    const top = await mkdtemp(join(tmpdir(), 'timings-'));
    onTestFinished(() => rm(top, { recursive: true, force: true }));
    expect(repositoryOf(top)).toBe(top);
  });
});

describe('fileTiming', () => {
  it('counts what the file took outside its tests as setup', () => {
    const timing = fileTiming(aFile([aTest('a', 30), aTest('b', 20)]), 'apps/server');
    expect(timing).toMatchObject({ package: 'apps/server', file: 'test/a.test.ts', setupMs: 5 + 10 + 20 + 15 + 50, testsMs: 50, teardownMs: 0, totalMs: 150 });
  });

  it('takes what a test says went to its database and app out of its own time', () => {
    const timing = fileTiming(aFile([aTest('a', 100, { setupMs: 60, teardownMs: 10 })]), '.');
    expect(timing).toMatchObject({ setupMs: 50 + 60, testsMs: 30, teardownMs: 10, totalMs: 150 });
    expect(timing.slowest).toEqual([{ name: 'a', ms: 30 }]);
  });

  it('never counts a run time shorter than its tests as negative', () => {
    expect(fileTiming(aFile([aTest('a', 300)], { duration: 100 }), '.')).toMatchObject({ setupMs: 50, testsMs: 300 });
  });

  it('never gives a test a negative time when it says it spent more than it took', () => {
    expect(fileTiming(aFile([aTest('a', 10, { setupMs: 60 })]), '.').testsMs).toBe(0);
  });

  it('counts a test that never ran as nothing', () => {
    expect(fileTiming(aFile([aTest('a', null)]), '.')).toMatchObject({ setupMs: 150, testsMs: 0, teardownMs: 0 });
  });

  it('names the slowest tests, slowest first, no more than it keeps', () => {
    const tests = Array.from({ length: SLOWEST_TESTS + 2 }, (_, i) => aTest(`test ${i}`, i));
    const { slowest } = fileTiming(aFile(tests), '.');
    expect(slowest).toHaveLength(SLOWEST_TESTS);
    expect(slowest[0]).toEqual({ name: `test ${SLOWEST_TESTS + 1}`, ms: SLOWEST_TESTS + 1 });
    expect(slowest.map(s => s.ms)).toEqual([...slowest.map(s => s.ms)].sort((a, b) => b - a));
  });

  it('cuts names the log would refuse', () => {
    const timing = fileTiming(aFile([aTest('n'.repeat(600), 1)], { relativeModuleId: 'f'.repeat(600) }), '.');
    expect(timing.file).toHaveLength(500);
    expect(timing.slowest[0]!.name).toHaveLength(500);
  });
});

describe('packageTiming', () => {
  it('finds the median over its files and the tests slower than it', () => {
    const files = [aFile([aTest('a', 10), aTest('b', 20)]), aFile([aTest('c', 30), aTest('d', 100, { setupMs: 60 })])];
    expect(packageTiming(files, 'apps/web')).toEqual({ package: 'apps/web', tests: 4, medianTestMs: 25, slowerThanMedian: 2 });
  });

  it('has nothing to say of a package with no tests', () => {
    expect(packageTiming([], '.')).toEqual({ package: '.', tests: 0, medianTestMs: 0, slowerThanMedian: 0 });
  });
});

describe('the reporter in a part of a run', () => {
  function run(part: string | undefined, root: string) {
    vi.stubEnv('HH_TEST_PART', part as string);
    /* This reporter speaks of made-up files: under a report of the real run it would write them over that report. */
    vi.stubEnv('HH_TEST_REPORT', '');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    onTestFinished(() => { write.mockRestore(); });
    const reporter = new TestTimings();
    reporter.onInit({ config: { root } } as unknown as Vitest);
    reporter.onTestRunEnd([aFile([aTest('a', 30)])]);
    return write.mock.calls.map(c => String(c[0])).join('');
  }

  it('prints each file and its package, named from the repository', async () => {
    const top = await mkdtemp(join(tmpdir(), 'timings-'));
    onTestFinished(() => rm(top, { recursive: true, force: true }));
    await mkdir(join(top, '.git'));
    await mkdir(join(top, 'apps/node'), { recursive: true });
    const { files, packages } = parseTimingLines(run('2', join(top, 'apps/node')));
    expect(files.map(f => [f.package, f.file])).toEqual([['apps/node', 'test/a.test.ts']]);
    expect(packages.map(p => p.package)).toEqual(['apps/node']);
  });

  it('names a package at the top of a repository by a dot', async () => {
    const top = await mkdtemp(join(tmpdir(), 'timings-'));
    onTestFinished(() => rm(top, { recursive: true, force: true }));
    await mkdir(join(top, '.git'));
    expect(parseTimingLines(run('1', top)).packages[0]!.package).toBe('.');
  });

  it('prints nothing outside a part', async () => {
    const top = await mkdtemp(join(tmpdir(), 'timings-'));
    onTestFinished(() => rm(top, { recursive: true, force: true }));
    expect(run('', top)).toBe('');
  });
});
