import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseTimingLines } from '../src/pipeline-report.js';
import TestTimings from '../src/test-timings-reporter.js';
import type { TestModule } from 'vitest/node';

const ROOT = resolve(import.meta.dirname, '..');
const REPORTER = join(ROOT, 'src/test-timings-reporter.ts');
const TIMING = '::hh-test-timing::';
const SPEC = `
import { expect, it, onTestFinished } from 'vitest';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
it('is quick', () => expect(1).toBe(1));
it('is quick too', () => expect(2).toBe(2));
it('opens a database', async ({ task }) => {
  await pause(60);
  task.meta.setupMs = 60;
  onTestFinished(async () => {
    await pause(40);
    task.meta.teardownMs = 40;
  });
  await pause(100);
});
`;

/* A real run of the runner on a test file of its own, as a part of a run makes one. */
async function runner(env: Record<string, string>, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(ROOT, 'test/.timings-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'sample.test.ts'), SPEC);
  for (const [name, text] of Object.entries(extra)) await writeFile(join(dir, name), text);
  const child = spawn('npx', ['--no-install', 'vitest', 'run', '--root', dir, `--reporter=${REPORTER}`, '--reporter=default'], { cwd: ROOT, env: { ...process.env, ...env, NO_COLOR: '1', HH_TEST_PART: env.HH_TEST_PART ?? '', HH_TEST_REPORT: env.HH_TEST_REPORT ?? '' } });
  let out = '';
  child.stdout.on('data', chunk => (out += String(chunk)));
  child.stderr.on('data', chunk => (out += String(chunk)));
  const code = await new Promise(done => child.on('close', done));
  return { code, out, dir };
}

describe('the timing reporter', () => {
  it('keeps complete names and messages for the node to hide secrets before making a short summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hh-full-failure-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'report.json');
    const oldReport = process.env.HH_TEST_REPORT, oldPart = process.env.HH_TEST_PART;
    onTestFinished(() => {
      if (oldReport === undefined) delete process.env.HH_TEST_REPORT; else process.env.HH_TEST_REPORT = oldReport;
      if (oldPart === undefined) delete process.env.HH_TEST_PART; else process.env.HH_TEST_PART = oldPart;
    });
    process.env.HH_TEST_REPORT = path; process.env.HH_TEST_PART = '';
    const secret = 'private-token-0123456789abcdefghijklmnop';
    const name = 'n'.repeat(490) + secret, message = 'm'.repeat(1990) + secret + '\nsecond line';
    const module = { moduleId: '/recorded/failure.test.ts', relativeModuleId: 'failure.test.ts', state: () => 'failed', diagnostic: () => ({ duration: 1 }), errors: () => [],
      children: { allTests: () => [{ fullName: name, result: () => ({ state: 'failed', errors: [{ message }] }) }] } } as unknown as TestModule;
    new TestTimings().onTestRunEnd([module]);
    const files = JSON.parse(await readFile(path, 'utf8')).files as { failures: { name: string; message: string }[] }[];
    expect(files[0]!.failures).toEqual([{ name, message }]);
  });

  it('prints nothing outside a run of Hornhoof', async () => {
    const { code, out } = await runner({});
    expect(code).toBe(0);
    expect(parseTimingLines(out)).toEqual({ files: [], packages: [] });
  }, 60_000);

  it('prints each file with its setup, tests and teardown, and its package', async () => {
    const { code, out } = await runner({ HH_TEST_PART: '1' });
    expect(code).toBe(0);
    const { files, packages } = parseTimingLines(out);
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
    expect(out.lastIndexOf(TIMING)).toBeLessThan(out.lastIndexOf('Test Files'));
  }, 60_000);

  it('names how each file went in the file a part of a run asks for', async () => {
    const report = join(tmpdir(), `hh-report-${process.pid}-${Date.now()}.json`);
    onTestFinished(() => rm(report, { force: true }));
    const failing = "import { expect, it } from 'vitest';\nit('fails', () => expect(1).toBe(2));\n";
    const skipped = "import { it } from 'vitest';\nit.skip('waits', () => {});\n";
    const { code, dir } = await runner({ HH_TEST_REPORT: report }, { 'failing.test.ts': failing, 'skipped.test.ts': skipped });
    expect(code).toBe(1);
    const { files } = JSON.parse(await readFile(report, 'utf8')) as { files: { file: string; status: string; ms: number }[] };
    const status = Object.fromEntries(files.map(file => [file.file.slice(dir.length + 1), file.status]));
    expect(status).toEqual({ 'sample.test.ts': 'passed', 'failing.test.ts': 'failed' });
    expect(files.every(file => file.file.startsWith('/') && file.ms >= 0)).toBe(true);
  }, 60_000);

  /* The node ends a failed part's log with these, so an agent reads which test failed and why. */
  it('names each test that failed with its error, and the error of a file that failed before its tests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hh-recorded-failures-')), report = join(dir, 'report.json');
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const oldReport = process.env.HH_TEST_REPORT, oldPart = process.env.HH_TEST_PART;
    onTestFinished(() => {
      if (oldReport === undefined) delete process.env.HH_TEST_REPORT; else process.env.HH_TEST_REPORT = oldReport;
      if (oldPart === undefined) delete process.env.HH_TEST_PART; else process.env.HH_TEST_PART = oldPart;
    });
    process.env.HH_TEST_REPORT = report; process.env.HH_TEST_PART = '';
    /* Recorded runner objects exercise our reporter, without running Vitest's programs or their clocks. */
    const passed = { fullName: 'group > passes', result: () => ({ state: 'passed' }) };
    const failed = { fullName: 'group > fails', result: () => ({ state: 'failed', errors: [{ message: 'expected 1 to be 2' }] }) };
    const module = (file: string, state: string, tests: unknown[], errors: unknown[] = []) => ({ moduleId: join(dir, file), relativeModuleId: file, state: () => state,
      diagnostic: () => ({ duration: 1 }), errors: () => errors, children: { allTests: () => tests } }) as unknown as TestModule;
    new TestTimings().onTestRunEnd([module('sample.test.ts', 'passed', [passed]), module('failing.test.ts', 'failed', [passed, failed]),
      module('broken.test.ts', 'failed', [], [{ message: 'cannot load the fixture' }])]);
    const { files } = JSON.parse(await readFile(report, 'utf8')) as { files: { file: string; failures?: { name: string; message: string }[] }[] };
    const failures = Object.fromEntries(files.map(file => [file.file.slice(dir.length + 1), file.failures]));
    expect(failures['sample.test.ts']).toBeUndefined();
    expect(failures['failing.test.ts']).toEqual([{ name: 'group > fails', message: expect.stringContaining('expected 1 to be 2') }]);
    expect(failures['broken.test.ts']).toEqual([{ name: 'broken.test.ts', message: expect.stringContaining('cannot load the fixture') }]);
  });
});
