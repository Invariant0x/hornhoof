import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseTimingLines } from '../src/pipeline-report.js';

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
async function runner(env: Record<string, string>) {
  const dir = await mkdtemp(join(ROOT, 'test/.timings-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'sample.test.ts'), SPEC);
  const child = spawn('npx', ['--no-install', 'vitest', 'run', '--root', dir, `--reporter=${REPORTER}`, '--reporter=default'], { cwd: ROOT, env: { ...process.env, ...env, NO_COLOR: '1', HH_TEST_PART: env.HH_TEST_PART ?? '' } });
  let out = '';
  child.stdout.on('data', chunk => (out += String(chunk)));
  child.stderr.on('data', chunk => (out += String(chunk)));
  const code = await new Promise(done => child.on('close', done));
  return { code, out, dir };
}

describe('the timing reporter', () => {
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
});
