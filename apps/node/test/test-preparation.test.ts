import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parseTestEnvironment, type EnvironmentDescription, type InputDigest } from '@hornhoof/protocol';
import * as environment from '../src/test-environment.js';
import { restoreCache, type CacheEntry } from '../src/test-cache.js';
const execute = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const command = (code: string) => ({ program: process.execPath, args: ['-e', code], cwd: '.' });
async function setup(cache: 'copy' | 'none' = 'copy') {
  const root = await mkdtemp(join(tmpdir(), 'hh-preparation-')); roots.push(root);
  const checkout = join(root, 'checkout'); await mkdir(checkout);
  const manifest = parseTestEnvironment({ version: 1, defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }], runtimes: [{ id: 'node', version: process.versions.node.split('.')[0] }],
    dependencies: { adapter: 'npm', inputs: ['package-lock.json'], cache, paths: ['node_modules'], install: [command("const f=require('fs'); f.mkdirSync('node_modules'); f.writeFileSync('node_modules/dependency','locked');")] },
    services: [], prepare: [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migration.sql'], commands: [command("const f=require('fs'); f.mkdirSync('template'); f.writeFileSync('template/db',f.readFileSync('migration.sql')); ")], artifacts: [{ path: 'template', format: 'directory', env: 'HH_TEMPLATE' }] }], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['test.js'], run: command(''), split: { kind: 'argv-files' }, profiles: ['fast'] }], impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No rollback.' } }, mutation: { status: 'unsupported', language: 'typescript', reason: 'No plan.' } });
  await writeFile(join(checkout, 'package-lock.json'), 'lock A'); await writeFile(join(checkout, 'migration.sql'), 'schema A');
  const description: EnvironmentDescription = { version: 1, repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'c'.repeat(64) }, commitSha: 'a'.repeat(40), manifestSource: JSON.stringify(manifest), manifestHash: sha(JSON.stringify(manifest)), manifest, inputDigests: [{ path: 'package-lock.json', digest: sha('lock A') }, { path: 'migration.sql', digest: sha('schema A') }], inventory: [{ suiteId: 'unit', file: 'test.js', selectionUnit: 'test.js' }], runtimeCapabilities: [{ id: 'node', version: process.versions.node, fingerprint: 'f'.repeat(64) }] };
  const commands: string[] = [], closed: string[] = [];
  const context = { cacheRoot: join(root, 'cache'), checkout, profile: 'fast', attemptRoot: join(root, 'attempt'), nodeOwner: { uid: 0, gid: 0 }, jobUser: { uid: 20000, gid: 20000 }, deadline: Date.now() + 10_000, signal: new AbortController().signal, env: {}, registerSecrets: () => {}, log: () => {},
    run: async (cmd: typeof manifest.suites[0]['run']) => { commands.push('direct'); await execute(cmd.program, cmd.args, { cwd: join(checkout, cmd.cwd) }); }, quiesce: async () => {},
    builder: async (inputs: InputDigest[], dependencies: CacheEntry | null) => {
      const build = await mkdtemp(join(root, 'builder-'));
      for (const input of inputs.filter(input => input.digest !== null)) { await mkdir(dirname(join(build, input.path)), { recursive: true }); await cp(join(checkout, input.path), join(build, input.path)); }
      if (dependencies) await restoreCache(dependencies, build, context);
      return { root: build, user: { uid: 20001, gid: 20001 }, env: {}, run: async (cmd: typeof manifest.suites[0]['run']) => { commands.push('build'); await execute(cmd.program, cmd.args, { cwd: join(build, cmd.cwd) }); }, quiesce: async () => { closed.push('quiesce'); }, close: async () => { closed.push('close'); await rm(build, { recursive: true, force: true }); } };
    },
  };
  return { root, checkout, description, context, commands, closed };
}
it('builds once, restores private dependencies and templates, and invalidates only changed declared inputs', async () => {
  const f = await setup(), dependencies = await environment.prepareDependencies(f.description, f.context);
  const first = await environment.prepareEnvironment(f.description, dependencies, f.context);
  expect(dependencies.receipt.hit).toBe(false); expect(first.receipts[0].hit).toBe(false); expect(f.commands).toEqual(['build', 'build']); expect(f.closed).toEqual(['quiesce', 'close', 'quiesce', 'close']);
  await writeFile(join(f.checkout, 'node_modules/dependency'), 'private mutation'); await rm(join(f.checkout, 'template'), { recursive: true });
  const warmDependencies = await environment.prepareDependencies(f.description, f.context), warm = await environment.prepareEnvironment(f.description, warmDependencies, f.context);
  expect(warmDependencies.receipt).toEqual({ key: dependencies.receipt.key, hit: true }); expect(warm.receipts[0]).toMatchObject({ hit: true }); expect(f.commands).toHaveLength(2);
  expect(await readFile(join(f.checkout, 'node_modules/dependency'), 'utf8')).toBe('locked'); expect(warm.env.HH_TEMPLATE).toBe(join(f.checkout, 'template'));
  await writeFile(join(f.checkout, 'migration.sql'), 'schema B'); f.description.inputDigests[1].digest = sha('schema B');
  await rm(join(f.checkout, 'template'), { recursive: true });
  const changed = await environment.prepareEnvironment(f.description, warmDependencies, f.context);
  expect(changed.receipts[0]).toMatchObject({ hit: false }); expect(f.commands).toHaveLength(3); expect(await readFile(join(f.checkout, 'template/db'), 'utf8')).toBe('schema B');
});
it('runs cache:none in its final checkout without relocating absolute-path environments or claiming hits', async () => {
  const f = await setup('none');
  f.description.manifest.dependencies.install = [command("require('fs').writeFileSync('absolute-path',process.cwd())")];
  f.description.manifest.dependencies.paths = ['absolute-path'];
  const dependencies = await environment.prepareDependencies(f.description, f.context);
  expect(dependencies.receipt).toEqual({ key: null, hit: false }); expect(dependencies.entry).toBeNull(); expect(f.commands).toEqual(['direct']); expect(await readFile(join(f.checkout, 'absolute-path'), 'utf8')).toBe(f.checkout);
});
it('stops an isolated builder before importing any payload and closes it after a failed command', async () => {
  const f = await setup();
  f.description.manifest.dependencies.install = [command("process.exit(7)")];
  await expect(environment.prepareDependencies(f.description, f.context)).rejects.toThrow();
  expect(f.closed).toEqual(['quiesce', 'close']);
});
