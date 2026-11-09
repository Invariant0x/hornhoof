import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Suite, TestCase } from '@playwright/test/reporter';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import FileReport from '../e2e/file-report';

const WEB = resolve(__dirname, '..');
/* The folder the recorded specs ran in: the paths of the record are relative to it. */
const SPECS = join(WEB, 'test/.report-recorded');

type Recorded = { tests: { location: { file: string }; outcome: string; results: { duration: number }[] }[] };
/* What Playwright 1.64.1 handed a reporter in three real runs of the specs written in the file, recorded once by hand (its
   "recorded" says how). These tests start no runner. */
const RUNS = JSON.parse(readFileSync(join(WEB, 'test/playwright-reporter-runs.json'), 'utf8')) as Record<'mixed' | 'maxFailures' | 'retries', Recorded>;

type Reported = { files: { file: string; status: string; ms: number }[] };

/* The calls a run makes on the reporter, with the tests of the recorded run as they stood at its end. */
async function run(recorded: Recorded) {
  const dir = await mkdtemp(join(tmpdir(), 'hh-file-report-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const report = join(dir, 'report.json');
  vi.stubEnv('HH_TEST_REPORT', report);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const tests = recorded.tests.map(test => ({ ...test, location: { ...test.location, file: join(SPECS, test.location.file) }, outcome: () => test.outcome }));
  const reporter = new FileReport();
  reporter.onBegin({}, { allTests: () => tests as unknown as TestCase[] } as unknown as Suite);
  reporter.onEnd();
  const { files } = JSON.parse(await readFile(report, 'utf8')) as Reported;
  return { files, status: Object.fromEntries(files.map(file => [file.file.slice(SPECS.length + 1), file.status])) };
}

describe('the report of how each spec file went', () => {
  it('names a file failed when any of its tests failed, and passed when none did', async () => {
    const { status, files } = await run(RUNS.mixed);
    expect(status).toEqual({ 'good.spec.ts': 'passed', 'mixed.spec.ts': 'failed', 'waiting.spec.ts': 'passed' });
    expect(files.every(file => file.file.startsWith('/') && file.ms >= 0)).toBe(true);
  });

  it('never calls a file passed when its tests did not get to run', async () => {
    const { status } = await run(RUNS.maxFailures);
    expect(status).toEqual({ 'first.spec.ts': 'failed', 'second.spec.ts': 'failed' });
  });

  it('counts a test that only passed on a second try against its file', async () => {
    const { status } = await run(RUNS.retries);
    expect(status).toEqual({ 'shaky.spec.ts': 'failed' });
  });
});
