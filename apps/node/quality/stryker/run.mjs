import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCache } from './cache.mjs';

const pilot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(pilot, '../../../..');

export function run(command, args, cwd = pilot, accepted = [0]) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = result.stdout + result.stderr;
  process.stdout.write(output);
  if (!accepted.includes(result.status)) throw new Error(`${command} exited ${result.status}`);
  return { seconds: (performance.now() - started) / 1000, exit: result.status, output };
}

export async function prepare(pilotRoot = pilot, repositoryRoot = root) {
  for (const directory of ['src', 'test', 'reports']) await mkdir(path.join(pilotRoot, directory), { recursive: true });
  await copyFile(path.join(repositoryRoot, 'apps/node/src/redact.ts'), path.join(pilotRoot, 'src/redact.ts'));
  await copyFile(path.join(repositoryRoot, 'apps/node/test/redact.test.ts'), path.join(pilotRoot, 'test/redact.test.ts'));
  const changed = await prepareCache(pilotRoot);
  console.log(changed ? 'Incremental cache invalidated.' : 'Incremental cache retained.');
}

export function counts(statuses) {
  const result = {};
  for (const status of statuses) result[status] = (result[status] ?? 0) + 1;
  return result;
}

async function compareWithMutator() {
  run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--coverage']);
  const coverageDirectory = path.join(root, 'coverage/quality-pilot');
  await mkdir(coverageDirectory, { recursive: true });
  await copyFile(path.join(pilot, 'coverage/lcov.info'), path.join(coverageDirectory, 'lcov.info'));
  const command = 'cd apps/node/quality/stryker && ./node_modules/.bin/vitest run --maxWorkers=1';
  const result = run(process.env.MUTATOR_BIN ?? 'mutator', [
    '--root', '.', 'apps/node/quality/stryker/src/redact.ts',
    '--use-existing-coverage', '--mutate-all', '--max-workers', '1', '--test-command', command,
  ], root, [0, 3]);
  await writeFile(path.join(pilot, 'reports/mutator.log'), result.output);
  return { seconds: result.seconds, exit: result.exit,
    counts: counts([...result.output.matchAll(/^(KILLED|SURVIVED|UNCOVERED|COMPILE_ERROR|TIMEOUT)\s/gm)].map(match => match[1])) };
}

async function main() {
  await prepare();
  const stryker = run(process.execPath, ['node_modules/@stryker-mutator/core/bin/stryker.js', 'run', 'stryker.config.mjs']);
  await writeFile(path.join(pilot, 'reports/stryker.log'), stryker.output);
  const report = JSON.parse(await readFile(path.join(pilot, 'reports/mutation.json'), 'utf8'));
  const mutants = Object.values(report.files).flatMap(file => file.mutants);
  const source = await readFile(path.join(pilot, 'src/redact.ts'));
  const tests = await readFile(path.join(pilot, 'test/redact.test.ts'));
  const summary = { inputs: {
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    testsSha256: createHash('sha256').update(tests).digest('hex'),
    node: process.version,
    versions: JSON.parse(await readFile(path.join(pilot, 'package.json'), 'utf8')).devDependencies,
  }, stryker: { seconds: stryker.seconds, exit: stryker.exit, counts: counts(mutants.map(mutant => mutant.status)) } };

  if (process.argv.includes('--compare')) summary.mutator = await compareWithMutator();
  await writeFile(path.join(pilot, 'reports/summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
