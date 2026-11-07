import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

const WEB = resolve(__dirname, '..');
const REPORTER = join(WEB, 'e2e/file-report.ts');
const HEAD = "import { expect, test } from '@playwright/test';\n";

type Reported = { files: { file: string; status: string; ms: number }[] };

/* A real run of the runner on spec files of its own. None of them opens a browser, so none is needed here. */
async function run(specs: Record<string, string>, options = '') {
  const dir = await mkdtemp(join(WEB, 'test/.report-'));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(specs)) await writeFile(join(dir, name), HEAD + text);
  await writeFile(join(dir, 'playwright.config.ts'), `export default { testDir: '.', outputDir: 'results', workers: 1, reporter: [[${JSON.stringify(REPORTER)}]], ${options} };\n`);
  const report = join(dir, 'report.json');
  const child = spawn('npx', ['--no-install', 'playwright', 'test', '--config', join(dir, 'playwright.config.ts')], { cwd: WEB, env: { ...process.env, NO_COLOR: '1', HH_TEST_REPORT: report }, stdio: 'ignore' });
  await new Promise(done => child.on('close', done));
  const { files } = JSON.parse(await readFile(report, 'utf8')) as Reported;
  return { files, status: Object.fromEntries(files.map(file => [file.file.slice(dir.length + 1), file.status])) };
}

describe('the report of how each spec file went', () => {
  it('names a file failed when any of its tests failed, and passed when none did', async () => {
    const { status, files } = await run({
      'good.spec.ts': "test('a', () => {});\ntest('b', () => {});\n",
      'mixed.spec.ts': "test('a', () => {});\ntest('b', () => expect(1).toBe(2));\n",
      'waiting.spec.ts': "test.skip('a', () => {});\ntest('b', () => test.skip());\n",
    });
    expect(status).toEqual({ 'good.spec.ts': 'passed', 'mixed.spec.ts': 'failed', 'waiting.spec.ts': 'passed' });
    expect(files.every(file => file.file.startsWith('/') && file.ms >= 0)).toBe(true);
  }, 120_000);

  it('never calls a file passed when its tests did not get to run', async () => {
    const { status } = await run({
      'first.spec.ts': "test('a', () => expect(1).toBe(2));\n",
      'second.spec.ts': "test('a', () => {});\n",
    }, 'maxFailures: 1');
    expect(status).toEqual({ 'first.spec.ts': 'failed', 'second.spec.ts': 'failed' });
  }, 120_000);

  it('counts a test that only passed on a second try against its file', async () => {
    const { status } = await run({
      'shaky.spec.ts': "test('a', ({}, info) => expect(info.retry).toBe(1));\n",
    }, 'retries: 1');
    expect(status).toEqual({ 'shaky.spec.ts': 'failed' });
  }, 120_000);
});
