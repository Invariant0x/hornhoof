import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
const sharedState = vi.hoisted(() => ({ builderFiles: new Set<string>() }));
import type { TestEnvironmentV1, TestService, ServerMessage } from '@hornhoof/protocol';
// Only the unavailable OS identity operations are doubled. Git, files, cache, commands and cleanup are real.
vi.mock('node:child_process', async original => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: (bin: string, args: string[], options: import('node:child_process').SpawnOptions) => {
    const child = module.spawn(bin, args, { ...options, uid: undefined, gid: undefined });
    if (child.send) {
      const originalSend = child.send;
      vi.spyOn(child, 'send').mockImplementation((message, ...rest) => Reflect.apply(originalSend, child, [typeof message === 'object' && message !== null && 'uid' in message ? { ...message, uid: process.getuid?.(), gid: process.getgid?.() } : message, ...rest]) as boolean);
    }
    return child;
  } };
});
vi.mock('node:fs', async original => { const module = await original<typeof import('node:fs')>(); return { ...module, chownSync: () => {}, lstatSync: (path: import('node:fs').PathLike) => { const stat = module.lstatSync(path); return sharedState.builderFiles.has(String(path)) ? Object.assign(stat, { uid: 20001 }) : stat; } }; });
vi.mock('../src/isolation.js', async original => {
  const module = await original<typeof import('../src/isolation.js')>();
  return { ...module, userFor: () => ({ uid: 20001, gid: 20001 }), ensurePasswd: () => {}, prepareFolder: (path: string) => module.prepareFolder(path, null) };
});
import { readTestEnvironment } from '../src/test-environment.js';
import { runTests } from '../src/tests.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const command = (code: string) => ({ program: 'node', args: ['-e', code], cwd: '.' });
async function fixture(configure?: (manifest: TestEnvironmentV1) => void) {
  const root = await mkdtemp(join(tmpdir(), 'hh-product-contract-')); roots.push(root);
  const source = join(root, 'source'); await mkdir(join(source, '.hornhoof'), { recursive: true }); await mkdir(join(root, 'proc'));
  const manifest: TestEnvironmentV1 = { version: 1, defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }], runtimes: [{ id: 'node', version: process.versions.node.split('.')[0] }],
    dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [command("const f=require('fs');f.mkdirSync('node_modules');f.writeFileSync('node_modules/ready','dep')")], paths: ['node_modules'], cache: 'copy' },
    services: [], prepare: [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migration.sql'], commands: [command("const f=require('fs');f.mkdirSync('template');f.writeFileSync('template/ready',f.readFileSync('migration.sql'))")], artifacts: [{ path: 'template', format: 'directory', env: 'HH_TEMPLATE' }] }], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['test.js'], run: { program: 'node', args: ['test.js'], cwd: '.' }, split: { kind: 'argv-files' }, profiles: ['fast'] }], impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No rollback.' } }, mutation: { status: 'unsupported', language: 'javascript', reason: 'Not configured.' } };
  configure?.(manifest);
  await writeFile(join(source, '.hornhoof/test-environment.json'), JSON.stringify(manifest)); await writeFile(join(source, 'package-lock.json'), '{"lockfileVersion":3}'); await writeFile(join(source, 'migration.sql'), 'schema ready');
  await writeFile(join(source, 'test.js'), "const f=require('fs');if(f.readFileSync(process.env.HH_TEMPLATE+'/ready','utf8')!=='schema ready'||f.readFileSync('node_modules/ready','utf8')!=='dep')process.exit(7);console.log('product ready',JSON.stringify(process.argv.slice(2))); ");
  const git = (...args: string[]) => execFileSync('git', args, { cwd: source, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' }, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'Product fixture');
  const commitSha = git('rev-parse', 'HEAD'), repo = { url: pathToFileURL(source).href, token: '' };
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(repo.url).digest('hex') }, dir = join(root, 'node');
  const description = await readTestEnvironment(repo, repositoryScope, commitSha, { cacheRoot: join(dir, 'cache'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} });
  const msg: Extract<ServerMessage, { type: 'tests.run' }> = { type: 'tests.run', partId: 'part-one', repo, repositoryScope, commitSha, branch: null, task: 1, command: '', part: 1, parts: 1, timeoutMs: 10_000, environment: { snapshot: { description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'unit', files: ['test.js'] } } };
  return { root, source, dir, msg };
}
it('executes cold then warm pinned product commands and returns validated cache/phase evidence', async () => {
  const f = await fixture(), options = { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} };
  const cold = await runTests(f.msg, options);
  expect(cold).toMatchObject({ ok: true, commit: f.msg.commitSha, environmentReceipt: { dependencies: { hit: false }, environments: [{ unitId: 'schema', hit: false }] } }); expect(cold.log).toContain('product ready ["./test.js"]');
  const warm = await runTests({ ...f.msg, partId: 'part-two' }, options);
  expect(warm).toMatchObject({ ok: true, environmentReceipt: { dependencies: { hit: true }, environments: [{ hit: true }], files: ['test.js'] } });
  expect(Object.values(warm.environmentReceipt!.phases).every(value => value >= 0)).toBe(true);
  await expect(readFile(join(f.dir, 'runs', 'part-two', 'repo', 'test.js'))).rejects.toThrow();
});
it('refuses product execution without a distinct isolated job user and rejects forged pinned evidence', async () => {
  const f = await fixture();
  const refused = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: null, hidden: [] }); expect(refused.ok).toBe(false); expect(refused.log).toContain('isolation_missing');
  f.msg.environment!.snapshot.description.manifestHash = 'f'.repeat(64);
  const forged = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(forged.ok).toBe(false); expect(forged.log).toContain('description_mismatch');
});

it('rejects stale tracked input evidence at the same SHA before running a product command', async () => {
  const f = await fixture(); f.msg.environment!.snapshot.description.inputDigests[0].digest = 'f'.repeat(64);
  const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(result).toMatchObject({ ok: false, commit: null }); expect(result.log).toContain('description_mismatch'); expect(result.log).not.toContain('product ready');
});

it('integrates the real process service provider with cached stopped state and private per-part copies', async () => {
  const f = await fixture(manifest => {
    manifest.dependencies.install = []; manifest.dependencies.paths = []; manifest.dependencies.inputs = [];
    manifest.services = [fixtureService()];
    manifest.prepare = [{ id: 'state', profiles: ['fast'], serviceIds: ['fixture'], inputs: [], commands: [command("require('fs').writeFileSync(process.env.HH_SERVICE_STATE+'/data/db','prepared')")], artifacts: [{ service: 'fixture', path: '.' }] }];
    manifest.suites[0].run = command("const f=require('fs'),p=require('path'),s=process.env.HH_SERVICE_STATE;if((f.statSync(p.resolve(s,'../../..')).mode&511)!==493)throw Error('service parent must be traversable');if(f.readFileSync(s+'/data/db','utf8')!=='prepared')process.exit(7);f.writeFileSync(s+'/data/db','consumer mutation');console.log('provider ready')");
  });
  const options = { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} };
  const first = await runTests(f.msg, options);
  expect(first, first.log + JSON.stringify(first.environmentReceipt?.phases)).toMatchObject({ ok: true, environmentReceipt: { environments: [{ unitId: 'state', hit: false }] } }); expect(first.log).toContain('provider ready');
  const warm = await runTests({ ...f.msg, partId: 'part-two' }, options);
  expect(warm).toMatchObject({ ok: true, environmentReceipt: { environments: [{ unitId: 'state', hit: true }] } }); expect(warm.log).toContain('provider ready');
});

function fixtureService(): TestService { return { id: 'fixture', runtime: 'node', profiles: ['fast'], driver: 'process', options: {
      start: command("const f=require('fs'),p=require('path'),s=process.env.HH_SERVICE_STATE;if(!f.existsSync(p.join(s,'data/db')))f.writeFileSync(p.join(s,'data/db'),'fresh');f.writeFileSync(p.join(s,'running'),'yes');process.on('SIGINT',()=>{f.rmSync(p.join(s,'running'),{force:true});process.exit(0)});setInterval(()=>{},100)"),
      readiness: command("const f=require('fs'),p=require('path'),s=process.env.HH_SERVICE_STATE;let n=0;const t=setInterval(()=>{if(f.existsSync(p.join(s,'running'))){clearInterval(t);process.exit(0)}if(n++>100)process.exit(1)},10)"),
      stop: { signal: 'SIGINT', graceMs: 1000 }, statePaths: ['data'],
    } }; }

it('opens a described service with fresh state when no preparation unit declares its template', async () => {
  const f = await fixture(manifest => {
    manifest.dependencies.install = []; manifest.dependencies.paths = []; manifest.dependencies.inputs = [];
    manifest.services = [fixtureService()]; manifest.prepare = [];
    manifest.suites[0].run = command("const f=require('fs');if(f.readFileSync(process.env.HH_SERVICE_STATE+'/data/db','utf8')!=='fresh')process.exit(7);console.log('fresh service')");
  });
  const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(result, result.log).toMatchObject({ ok: true, environmentReceipt: { environments: [] } }); expect(result.log).toContain('fresh service');
});

it('runs a part reset and passes a JSON file selection literally', async () => {
  const f = await fixture(manifest => {
    manifest.reset = [{ suiteIds: ['unit'], scope: 'part', inputs: [], command: command("require('fs').writeFileSync('reset-ready','yes')") }];
    manifest.suites[0].split = { kind: 'json-file' };
    manifest.suites[0].run = command("const f=require('fs');if(f.readFileSync('reset-ready','utf8')!=='yes')process.exit(7);console.log('json selection',f.readFileSync(process.env.HH_TEST_FILES,'utf8'))");
  });
  const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(result, result.log).toMatchObject({ ok: true }); expect(result.log).toContain('json selection ["./test.js"]');
});
it('executes its final leaf commands once without suite file arguments', async () => {
  const f = await fixture(manifest => { manifest.suites[0].finalChecks = [command("console.log('final leaf',JSON.stringify(process.argv.slice(1)))")]; });
  f.msg.environment!.selection = { kind: 'final', suiteId: 'unit', files: [] };
  const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(result, result.log).toMatchObject({ ok: true, environmentReceipt: { kind: 'final', files: [] } });
  expect(result.log.match(/final leaf \[\]/g)).toHaveLength(1);
});
async function commandOnlyFixture(code: string) {
  return fixture(manifest => { manifest.dependencies.install = []; manifest.dependencies.paths = []; manifest.dependencies.inputs = []; manifest.prepare = []; manifest.suites[0].run = command(code); });
}
it('reports a failing literal product command and still removes its attempt', async () => {
  const f = await commandOnlyFixture('process.exit(7)');
  const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(result).toMatchObject({ ok: false, error: 'failed', exitCode: 7 }); expect(result.log).toContain('exit 7');
});
it('retains cleanup through caller cancellation of a running product command', async () => {
  const f = await commandOnlyFixture("require('fs').writeFileSync('started','yes');setInterval(()=>{},100)"), stop = new AbortController();
  const result = runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], signal: stop.signal, prepareRepoBrowser: async () => {} });
  const started = join(f.dir, 'runs', f.msg.partId, 'repo', 'started'), end = Date.now() + 5000;
  while (await readFile(started).catch(() => null) === null) { if (Date.now() >= end) throw new Error('The command never started.'); await new Promise(resolve => setTimeout(resolve, 10)); }
  stop.abort(new Error('Caller cancelled'));
  expect(await result).toMatchObject({ ok: false, error: 'cancelled' }); await expect(readFile(started)).rejects.toThrow();
});
it('reports an execution timeout after reaching a product command and finishing cleanup', async () => {
  const f = await commandOnlyFixture("console.log('command reached');setInterval(()=>{},100)"); f.msg.timeoutMs = 5000;
  const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
  expect(result).toMatchObject({ ok: false, error: 'timeout' }); expect(result.log).toContain('command reached');
});


it.each([false, true])('sweeps builder shared state after preparation failure=%s', async fail => {
  const shared = join(tmpdir(), `hh399-builder-${randomUUID()}`); sharedState.builderFiles.add(shared);
  try {
    const f = await fixture(manifest => { manifest.dependencies.install = [command(`require('fs').writeFileSync(${JSON.stringify(shared)}, 'undeclared builder state');${fail ? 'process.exit(9)' : "require('fs').mkdirSync('node_modules');require('fs').writeFileSync('node_modules/ready','dep')"}`)]; });
    const result = await runTests(f.msg, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [], prepareRepoBrowser: async () => {} });
    expect(result.ok).toBe(!fail);
    await expect(readFile(shared)).rejects.toThrow();
  } finally { sharedState.builderFiles.delete(shared); await rm(shared, { force: true }); }
});

it('does not return a manual part until its disposable UID has quiesced', async () => {
  const f = await fixture(), processDir = join(f.root, 'proc', '2147483647'); await mkdir(processDir);
  await writeFile(join(processDir, 'status'), 'State: S (sleeping)\nUid: 20000 20000 20000 20000\n');
  let killed!: () => void, finished = false; const stopping = new Promise<void>(resolve => { killed = resolve; });
  const kill = process.kill.bind(process), spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => { if (pid === 2147483647) { killed(); return true; } return kill(pid, signal); });
  const running = runTests({ ...f.msg, environment: undefined, repo: null, kind: 'work', command: 'true' }, { dir: f.dir, proc: join(f.root, 'proc'), user: { uid: 20000, gid: 20000 }, hidden: [] }).then(result => { finished = true; return result; });
  try {
    await stopping; await new Promise<void>(resolve => setImmediate(resolve));
    expect(finished).toBe(false);
  } finally { await rm(processDir, { recursive: true }); await running; spy.mockRestore(); }
  expect((await running).ok).toBe(true);
});
