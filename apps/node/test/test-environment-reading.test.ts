import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, matchesGlob } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTestEnvironment } from '@hornhoof/protocol';
import { listTestUnits, readTestEnvironment } from '../src/test-environment.js';
import { readCommit } from '../src/test-mirror.js';

vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('node:path', async original => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, matchesGlob: vi.fn(actual.matchesGlob) };
});

const folders: string[] = [];
beforeEach(() => { vi.mocked(spawn).mockClear(); vi.mocked(matchesGlob).mockClear(); });
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const command = { program: 'node', args: ['-e', ''], cwd: '.' };
const manifest = {
  version: 1, defaultProfile: 'fast', runtimes: [], profiles: [{ id: 'fast', requiredSuiteIds: ['api'] }],
  dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [command], paths: ['node_modules'], cache: 'copy' },
  services: [], prepare: [{ id: 'schema', profiles: ['fast'], serviceIds: [], inputs: ['migrations/**'], commands: [command], artifacts: [{ path: 'template', format: 'directory' }] }],
  reset: null, suites: [{ id: 'api', root: 'app', files: ['app/test/**/*.test.ts'], run: { program: 'node', args: ['runner.js'], cwd: 'app' }, split: { kind: 'argv-files' }, profiles: ['fast'] }],
  impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'No rollback defined.' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'No plan configured.' },
};
async function fixture(files: Record<string, string | Buffer>) {
  const root = await mkdtemp(join(tmpdir(), 'hh-reading-')), cacheRoot = await mkdtemp(join(tmpdir(), 'hh-reading-cache-')); folders.push(root, cacheRoot);
  const everything = { '.hornhoof/test-environment.json': JSON.stringify(manifest), 'package-lock.json': '{}', 'app/test/a.test.ts': '// test', ...files };
  for (const [path, bytes] of Object.entries(everything)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  git(root, 'init', '--quiet'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'Everything');
  const source = { url: pathToFileURL(root).href, token: '' };
  const scope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: sha256(source.url) };
  return { sha: git(root, 'rev-parse', 'HEAD'), source, scope, context: { cacheRoot, signal: new AbortController().signal, deadline: Date.now() + 30_000, log: () => {} } };
}
const gitCalls = (word: string) => vi.mocked(spawn).mock.calls.filter(([, args]) => (args as string[]).includes(word));

describe('reading what a commit\'s harness is built from', () => {
  it('reads every input through one git process, whatever the files hold', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 'a\n'), looksLikeOutput = `${'b'.repeat(40)} blob 3\nabc\n`;
    const migrations: Record<string, string | Buffer> = { 'migrations/big.sql': big, 'migrations/empty.sql': '', 'migrations/tricky.sql': looksLikeOutput };
    for (let n = 0; n < 40; n++) migrations[`migrations/${n}.sql`] = `create table t${n}(id int);`;
    const f = await fixture(migrations);
    const described = await readTestEnvironment(f.source, f.scope, f.sha, f.context);
    expect(gitCalls('--batch')).toHaveLength(1);
    expect(gitCalls('blob').filter(([, args]) => !(args as string[]).includes('--batch')).length).toBeLessThanOrEqual(1);
    expect(described.inputDigests).toEqual(expect.arrayContaining(Object.entries(migrations).map(([path, bytes]) => ({ path, digest: sha256(bytes) }))));
    expect(described.inputDigests).toContainEqual({ path: 'package-lock.json', digest: sha256('{}') });
    expect(described.inputDigests).toHaveLength(44);
  });

  it('stops at a file over the limit, and hands each file over in the order asked', async () => {
    const f = await fixture({ 'small.txt': 'abc', 'large.txt': 'abcdefgh' }), tree = await readCommit(f.source, f.scope, f.sha, f.context), got: [string, string][] = [];
    await tree.readBlobs(['small.txt', 'large.txt'], 8, (path, bytes) => { got.push([path, bytes.toString('utf8')]); });
    expect(got).toEqual([['small.txt', 'abc'], ['large.txt', 'abcdefgh']]);
    await expect(tree.readBlobs(['small.txt', 'large.txt'], 4, () => {})).rejects.toThrow(/limit/i);
  });

  it('refuses to read through it what is not a tracked regular file', async () => {
    const f = await fixture({}), tree = await readCommit(f.source, f.scope, f.sha, f.context);
    await expect(tree.readBlobs(['missing.txt'], 64, () => {})).rejects.toThrow(/tracked regular file/);
    await expect(tree.readBlobs(['../outside'], 64, () => {})).rejects.toThrow();
  });

  it('reads nothing at all when no file is asked for', async () => {
    const f = await fixture({}), tree = await readCommit(f.source, f.scope, f.sha, f.context);
    vi.mocked(spawn).mockClear();
    await tree.readBlobs([], 64, () => {});
    expect(spawn).not.toHaveBeenCalled();
  });

  it('asks a compiled glob only about files its fixed part already fits', async () => {
    const others: Record<string, string> = {};
    for (let n = 0; n < 300; n++) others[`other/${n}.txt`] = String(n);
    const f = await fixture({ ...others, 'migrations/1.sql': 'one' });
    await readTestEnvironment(f.source, f.scope, f.sha, f.context);
    expect(vi.mocked(matchesGlob).mock.calls.length).toBeLessThan(20);
  });

  it.each([
    ['a.ts', 'a.ts'], ['src/a.ts', 'src'], ['src/a.ts', 'src/'], ['src/a.ts', 'src/**'], ['src/deep/a.ts', 'src/*'], ['src/deep/a.ts', 'src/**/*.ts'],
    ['a.ts', '*.ts'], ['src/a.ts', '*.ts'], ['src/a.ts', '**/*.ts'], ['src/a.ts', '{src,lib}/*.ts'], ['lib/a.ts', 'src/{a,b}.ts'], ['src/a.ts', 's?c/a.ts'], ['src/a.ts', '[sl]rc/a.ts'],
    ['a+b.ts', 'a+b.ts'], ['a.ts', '!(b).ts'], ['a.ts', './a.ts'], ['src/a.ts', 'src//a.ts'], ['src/a.ts', 'src/./a.ts'], ['apps/.hidden/x', 'apps/*/x'], ['apps/one/x', 'apps/*/x'], ['appsx/one/x', 'apps/*/x'], ['Src/a.ts', 'src/*.ts'],
  ])('selects %s with %s as the glob itself would', async (path, pattern) => {
    const actual = await vi.importActual<typeof import('node:path')>('node:path');
    const wanted = path === pattern || path.startsWith(`${pattern.replace(/\/$/, '')}/`) || actual.matchesGlob(path, pattern);
    const suite = { ...manifest.suites[0], files: [pattern] }, parsed = parseTestEnvironment({ ...manifest, suites: [suite] });
    expect(listTestUnits(parsed, [{ path, mode: '100644', oid: 'a'.repeat(40) }]).length === 1).toBe(wanted);
  });
});
