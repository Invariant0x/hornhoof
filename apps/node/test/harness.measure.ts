import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { it, vi } from 'vitest';
const ids = vi.hoisted(() => ({ jobUid: 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000, builderUid: 2_001_000_000 + (process.getuid?.() ?? 0) % 1_000_000 }));
import type { EnvironmentDescription, HarnessClaim, HarnessUnit, ServerMessage } from '@hornhoof/protocol';
// Only the OS identity operations a machine without root cannot do are doubled: git, npm, builds, files and commands are real.
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => module.spawn(bin, args, { ...options, uid: undefined, gid: undefined }) };
});
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), chownSync: () => {} }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), chown: async () => {} }));
vi.mock('../src/isolation.js', async original => {
  const module = await original<typeof import('../src/isolation.js')>();
  return { ...module, userFor: () => ({ uid: ids.builderUid, gid: ids.builderUid }), ensurePasswd: () => {}, prepareFolder: (path: string) => module.prepareFolder(path, null) };
});
import { readTestEnvironment } from '../src/test-environment.js';
import type { HarnessRemote } from '../src/test-harness.js';
import { runTests, syncHarness } from '../src/tests.js';

/* How long a run takes to reach its first test, before and after the shared harness, on this one machine. Start it from
   apps/node, on a committed tree: npx --no-install vitest run --config vitest.measure.config.ts. HH_MEASURE_OUT names the
   file that gets the results. */
const results: { step: string; seconds: number; note?: string }[] = [];
async function timed<T>(step: string, run: () => Promise<T> | T, note?: (value: T) => string): Promise<T> {
  const started = performance.now(), value = await run();
  results.push({ step, seconds: Math.round((performance.now() - started) / 10) / 100, ...(note ? { note: note(value) } : {}) });
  console.log(`${step}: ${results.at(-1)!.seconds} s${note ? ` (${note(value)})` : ''}`);
  return value;
}
const run = (cwd: string, env: NodeJS.ProcessEnv, program: string, ...args: string[]) => {
  const done = spawnSync(program, args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
  if (done.status !== 0) throw new Error(`${program} ${args.join(' ')} failed with ${done.status}.`);
};

/* What Hornhoof's registry does, with its bundles on this same disk, so moving them costs no network here. */
function registry(root: string) {
  const builds = new Map<string, { builder: string; file?: string; digest?: string; size?: number }>();
  const remote = (name: string): HarnessRemote => ({
    async claim(unit: HarnessUnit): Promise<HarnessClaim> {
      const build = builds.get(unit.key);
      if (build?.file) return { state: 'ready', digest: build.digest!, size: build.size!, partBytes: 32 * 1024 ** 2 };
      if (build && build.builder !== name) return { state: 'wait', afterMs: 100 };
      builds.set(unit.key, { builder: name });
      return { state: 'build', partBytes: 32 * 1024 ** 2 };
    },
    async upload(key, file, digest, size) { const kept = join(root, `${key}.zst`); await copyFile(file, kept); builds.set(key, { builder: name, file: kept, digest, size }); },
    async download(key, file) { await copyFile(builds.get(key)!.file!, file); },
    async failed(key, error) { console.log(`failed ${key}: ${error}`); builds.delete(key); },
  });
  return { builds, remote };
}

it('measures the time to the first test', async () => {
  const repository = resolve(import.meta.dirname, '../../..'), work = await mkdtemp(join(tmpdir(), 'hh-measure-'));
  const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const source = join(work, 'source');
  run(work, {}, 'git', 'clone', '--quiet', '--no-hardlinks', repository, source);
  const repo = { url: pathToFileURL(source).href, token: '' };
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(repo.url).digest('hex') };
  await mkdir(join(work, 'proc')); await mkdir(join(work, 'bundles'));
  const shared = registry(join(work, 'bundles'));
  const machine = (name: string) => ({ dir: join(work, name), proc: join(work, 'proc'), user: { uid: ids.jobUid, gid: ids.jobUid }, hidden: [], prepareRepoBrowser: async () => {}, harness: shared.remote(name) });
  const asked = (sha: string): Extract<ServerMessage, { type: 'tests.harness' }> => ({ type: 'tests.harness', requestId: randomUUID(), repositoryScope, repo, commitSha: sha });
  const ready = (done: Awaited<ReturnType<typeof syncHarness>>) => { if (done.result.status !== 'ready') throw new Error(JSON.stringify(done.result)); return `${done.result.keys.length} units`; };

  /* Before: a fresh folder, as a run with a command starts, with nothing to reuse. */
  const fresh = join(work, 'before'), home = join(work, 'before-home'), env = { HOME: home, npm_config_cache: join(home, 'npm') };
  await mkdir(home);
  const started = performance.now();
  await timed('before: clone', () => run(work, env, 'git', 'clone', '--quiet', '--depth', '1', repo.url, fresh));
  await timed('before: npm ci', () => run(fresh, env, 'npm', 'ci', '--no-audit', '--no-fund'));
  await timed('before: build protocol', () => run(fresh, env, 'npm', 'run', 'build', '-w', '@hornhoof/protocol'));
  await timed('before: build node', () => run(fresh, env, 'npm', 'run', 'build', '-w', '@hornhoof/node'));
  await timed('before: database template', () => run(join(fresh, 'apps/server'), env, 'node', '--import', 'tsx', 'test/prepare-environment.ts', '--output', '../../.hornhoof/prepared/pglite'));
  results.push({ step: 'before: total to the first test', seconds: Math.round((performance.now() - started) / 10) / 100 });
  console.log(`before total: ${results.at(-1)!.seconds} s`);
  await rm(fresh, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });

  /* After: one machine builds for all, another takes it, and a run on either finds it there. */
  const builder = machine('builder'), other = machine('other');
  await timed('after: first machine builds the harness', () => syncHarness(asked(commitSha), builder), ready);
  await timed('after: another machine takes it, no install, no build', () => syncHarness(asked(commitSha), other), ready);
  await timed('after: that machine asked again, nothing to do', () => syncHarness(asked(commitSha), other), ready);

  const description = await readTestEnvironment(repo, repositoryScope, commitSha, { cacheRoot: join(work, 'scratch'), deadline: Date.now() + 60_000, signal: new AbortController().signal, log: () => {} }) as EnvironmentDescription;
  const file = description.inventory.filter(unit => unit.suiteId === 'protocol').map(unit => unit.file).sort()[0]!;
  const part = (): Extract<ServerMessage, { type: 'tests.run' }> => ({ type: 'tests.run', partId: randomUUID(), repo, repositoryScope, commitSha, branch: null, task: 1, command: '', part: 1, parts: 1, timeoutMs: 600_000, environment: { snapshot: { description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'protocol', files: [file] } } });
  for (const [name, on] of [['first', other], ['second', other], ['on the first machine', builder]] as const) {
    const done = await runTests(part(), on);
    if (!done.ok) throw new Error(done.log.slice(-2000));
    const { checkoutMs, dependenciesMs, environmentMs, servicesMs, commandMs } = done.environmentReceipt!.phases, before = checkoutMs + dependenciesMs + environmentMs + servicesMs;
    results.push({ step: `after: a new run, ${name}: to its first test`, seconds: Math.round(before / 10) / 100, note: `checkout ${Math.round(checkoutMs)} ms, dependencies ${Math.round(dependenciesMs)} ms, prepared ${Math.round(environmentMs)} ms, then the tests took ${Math.round(commandMs)} ms; dependencies hit ${done.environmentReceipt!.dependencies.hit}` });
    console.log(`${results.at(-1)!.step}: ${results.at(-1)!.seconds} s (${results.at(-1)!.note})`);
  }
  const manual = await timed('after: a manual command, whole part', () => runTests({ ...part(), environment: undefined, command: `node -e "require('vitest/package.json')"` }, other), done => `ok ${done.ok}; ${/The harness is in place after [^.]*\./.exec(done.log)?.[0] ?? 'no harness'}`);
  if (!manual.ok) throw new Error(manual.log.slice(-2000));

  /* What a change costs: a new migration touches the database template and nothing else. */
  const migrations = join(source, 'apps/server/drizzle'), last = execFileSync('sh', ['-c', 'ls *.sql | tail -1'], { cwd: migrations, encoding: 'utf8' }).trim();
  await appendFile(join(migrations, last), '\n-- A change for the measurement.\n');
  run(source, {}, 'git', '-c', 'user.name=M', '-c', 'user.email=m@example.test', 'commit', '--quiet', '-am', 'Change a migration');
  const next = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  await timed('after: a migration changed, the first machine updates', () => syncHarness(asked(next), builder), ready);
  await timed('after: a migration changed, another machine takes the update', () => syncHarness(asked(next), other), ready);

  const sizes = [...shared.builds.values()].map(build => build.size ?? 0);
  console.log(`bundles: ${sizes.map(size => Math.round(size / 1024 / 1024)).join(', ')} MB`);
  const out = process.env.HH_MEASURE_OUT;
  if (out) await writeFile(out, JSON.stringify({ commitSha, cpus: execFileSync('nproc', { encoding: 'utf8' }).trim(), arch: process.arch, node: process.version, bundlesMb: sizes.map(size => Math.round(size / 1024 / 1024)), results }, null, 2));
  await rm(work, { recursive: true, force: true });
});
