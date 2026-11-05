import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

/* One fresh process per snapshot; never connects to the configured company database. */
const root = fileURLToPath(new URL('../', import.meta.url));
const worker = fileURLToPath(new URL('../apps/server/src/benchmark/run.ts', import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--commit')) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (revision.status !== 0) throw new Error('Cannot identify the measured commit.');
  args.push('--commit', revision.stdout.trim());
}
const result = spawnSync(process.execPath, ['--import', 'tsx', worker, ...args], { cwd: root, stdio: 'inherit', timeout: 120_000 });
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exitCode = result.status ?? 1;
