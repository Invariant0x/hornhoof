/* The release benchmark as a release runs it: a process of its own that loads the whole server through tsx, makes a new
   database with every migration and asks the real app. It runs with the slow tests, apart from every change's run. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';
import { Snapshot } from '../../src/benchmark/report.js';

it('launches the benchmark against an isolated real app and emits measured numbers', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
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
