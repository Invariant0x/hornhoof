// From the repository root: node docs/task-1221-series.mjs /tmp/task-1221-series
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { resolve } from 'node:path';

const root = process.cwd();
const output = resolve(process.argv[2]);
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const candidate = head();
const assertCandidate = () => {
  if (head() !== candidate || execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Candidate changed.');
};
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'source.txt'), candidate + '\n');
writeFileSync(resolve(output, 'series.csv'), 'iteration,candidate,exit,passed,failed,total,load1_start,load1_end\n');

for (let iteration = 1; iteration <= 10; iteration++) {
  assertCandidate();
  const prefix = resolve(output, 'run-' + String(iteration).padStart(2, '0'));
  writeFileSync(prefix + '.load.csv', 'utc,load1,load5,load15\n');
  const sample = () => appendFileSync(prefix + '.load.csv', new Date().toISOString() + ',' + loadavg().join(',') + '\n');
  const before = loadavg()[0];
  sample();
  const sampling = setInterval(sample, 2000);
  let code;
  try {
    code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [
        resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
        'test/worker-keeper-fixture.test.ts', 'test/worker-keeper.test.ts', '--maxWorkers=1',
        '--reporter=default', '--reporter=json', '--outputFile.json=' + prefix + '.json',
      ], { cwd: resolve(root, 'apps/server'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => appendFileSync(prefix + '.log', bytes));
      child.once('error', reject);
      child.once('exit', done);
    });
  } finally { clearInterval(sampling); sample(); }
  const result = JSON.parse(readFileSync(prefix + '.json', 'utf8'));
  const ok = code === 0 && result.success && result.numTotalTests === 31 && result.numPassedTests === 31
    && result.numFailedTests === 0 && result.numPendingTests === 0 && result.testResults.length === 2
    && result.testResults.every(file => file.status === 'passed');
  appendFileSync(resolve(output, 'series.csv'), [iteration, candidate, code, result.numPassedTests, result.numFailedTests, result.numTotalTests, before, loadavg()[0]].join(',') + '\n');
  console.log('SERIES', iteration, ok ? 'PASS' : 'FAIL', 'candidate', candidate, 'passed', result.numPassedTests, 'failed', result.numFailedTests);
  assertCandidate();
  if (!ok) throw new Error('Series stopped on failure.');
}
