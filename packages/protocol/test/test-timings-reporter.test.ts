import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { TestCase, TestModule, Vitest } from 'vitest/node';
import { parseTimingLines } from '../src/pipeline-report.js';
import TestTimings from '../src/test-timings-reporter.js';

const ROOT = resolve(import.meta.dirname, '..');

type Recorded = {
  root: string;
  modules: {
    moduleId: string; relativeModuleId: string; state: string; diagnostic: Record<string, unknown>;
    tests: { fullName: string; diagnostic: Record<string, unknown> | null; meta: Record<string, number> }[];
  }[];
};
/* What Vitest 5.0.5 handed a reporter in two real runs of the specs written in the file, recorded once by hand (its "recorded"
   says how): sample.test.ts alone, and beside a failing and a skipped file. These tests start no runner and wait for nothing. */
const RUNS = JSON.parse(readFileSync(join(ROOT, 'test/vitest-reporter-runs.json'), 'utf8')) as { sampleOnly: Recorded; withFailingAndSkipped: Recorded };

/* The calls a run makes on the reporter, with the objects of the recorded run under the folder it ran in. */
function reporting(recorded: Recorded, env: { HH_TEST_PART?: string; HH_TEST_REPORT?: string }) {
  vi.stubEnv('HH_TEST_PART', env.HH_TEST_PART ?? '');
  /* Under a part of a real run, a report of the made-up run would be written over the report of the real one. */
  vi.stubEnv('HH_TEST_REPORT', env.HH_TEST_REPORT ?? '');
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const root = join(ROOT, recorded.root);
  const modules = recorded.modules.map(module => {
    const tests = module.tests.map(test => ({ fullName: test.fullName, diagnostic: () => test.diagnostic ?? undefined, meta: () => test.meta }) as unknown as TestCase);
    return {
      moduleId: join(root, module.moduleId), relativeModuleId: module.relativeModuleId, state: () => module.state, diagnostic: () => module.diagnostic,
      children: { allTests: () => tests.values() },
    } as unknown as TestModule;
  });
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const reporter = new TestTimings();
    reporter.onInit({ config: { root } } as unknown as Vitest);
    reporter.onTestRunEnd(modules);
    return { out: write.mock.calls.map(call => String(call[0])).join(''), root };
  } finally { write.mockRestore(); }
}

describe('the timing reporter', () => {
  it('prints nothing outside a run of Hornhoof', () => {
    expect(parseTimingLines(reporting(RUNS.sampleOnly, {}).out)).toEqual({ files: [], packages: [] });
  });

  it('prints each file with its setup, tests and teardown, and its package', () => {
    const { files, packages } = parseTimingLines(reporting(RUNS.sampleOnly, { HH_TEST_PART: '1' }).out);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file!.file).toBe('sample.test.ts');
    expect(file!.package).toMatch(/^packages\/protocol\/test\/\.timings-/);
    expect(file!.setupMs).toBeGreaterThanOrEqual(60);
    expect(file!.teardownMs).toBeGreaterThanOrEqual(40);
    expect(file!.testsMs).toBeGreaterThanOrEqual(100);
    expect(file!.totalMs).toBeCloseTo(file!.setupMs! + file!.testsMs! + file!.teardownMs!, 0);
    expect(file!.slowest[0]!.name).toBe('opens a database');
    expect(file!.slowest.length).toBeLessThanOrEqual(5);
    expect(packages).toEqual([expect.objectContaining({ package: file!.package, tests: 3, slowerThanMedian: 1 })]);
  });

  it('names how each file went in the file a part of a run asks for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hh-report-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const report = join(dir, 'report.json');
    const { root } = reporting(RUNS.withFailingAndSkipped, { HH_TEST_REPORT: report });
    const { files } = JSON.parse(await readFile(report, 'utf8')) as { files: { file: string; status: string; ms: number }[] };
    const status = Object.fromEntries(files.map(file => [file.file.slice(root.length + 1), file.status]));
    expect(status).toEqual({ 'sample.test.ts': 'passed', 'failing.test.ts': 'failed' });
    expect(files.every(file => file.file.startsWith('/') && file.ms >= 0)).toBe(true);
  });
});
