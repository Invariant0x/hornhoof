import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const FileDigest = z.strictObject({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const fixtureRoot = fileURLToPath(new URL('./fixtures/preparation-replay/', import.meta.url));

async function regularFiles(root: string, directories: ReadonlySet<string>, prefix = ''): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name, stat = await lstat(join(root, path));
    if (stat.isDirectory()) {
      if (!directories.has(path)) throw new Error('Fixture inventory differs: an undeclared directory exists.');
      paths.push(...await regularFiles(root, directories, path));
    }
    else if (stat.isFile()) paths.push(path);
    else throw new Error('The replay fixture requires regular files without links.');
  }
  return paths.sort();
}

export async function inspectReplayFixture(root: string) {
  if (!(await lstat(root)).isDirectory()) throw new Error('The fixture root must be a real directory without links.');
  const expected = FileDigest.array().parse(JSON.parse(await readFile(new URL('./fixtures/preparation-replay-files.json', import.meta.url), 'utf8')));
  const directories = new Set(expected.flatMap(file => file.path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
  const paths = await regularFiles(root, directories);
  if (JSON.stringify(paths) !== JSON.stringify(expected.map(file => file.path))) throw new Error('Fixture inventory differs from the pinned workload.');
  for (const file of expected) {
    const digest = createHash('sha256').update(await readFile(join(root, file.path))).digest('hex');
    if (digest !== file.sha256) throw new Error(`Fixture bytes differ: ${file.path}`);
  }
  return {
    status: 'UNFIT' as const, measurement: 'NOT_RUN' as const, formatter: 'NOT_CONFIGURED' as const,
    baseline: 'f289196b97c9d6fea391248d76e422214f2638ad', candidate: '06f67aebce8bb2653d87c787535e1dd93a620405',
    files: expected,
    reasons: ['Actual common admission is not proven.', 'An equivalent measured adapter has not been executed or accepted.'],
    command: 'npm ci --offline --install-links --ignore-scripts --no-audit --fund=false && node prepare.cjs build && node prepare.cjs environment && node prepare.cjs ready',
  };
}

export async function replayCommand(args: string[], root = fixtureRoot) {
  if (args[0] === 'measure') throw new Error('Measurement is disabled: actual common admission and an equivalent adapter are required. Caller-supplied admission is not authority.');
  if (args.length !== 1 || args[0] !== 'plan') throw new Error('Use plan. This package does not execute measurements.');
  return inspectReplayFixture(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void replayCommand(process.argv.slice(2)).then(
    plan => console.log(JSON.stringify(plan, null, 2)),
    (error: unknown) => { console.error(error instanceof Error ? error.message : 'Replay audit failed.'); process.exitCode = 1; },
  );
}
