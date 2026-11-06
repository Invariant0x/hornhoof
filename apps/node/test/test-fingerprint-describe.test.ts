import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestsDescribed, type NodeMessage } from '@hornhoof/protocol';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';
import { NodeTestMessages, describeTestEnvironment } from '../src/test-environment.js';
import { readCommit } from '../src/test-mirror.js';

const folders: string[] = [];
afterEach(async () => { setCheckClient(null); await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
const manifest = {
  version: 1, defaultProfile: 'fast', runtimes: [{ id: 'node', version: '22' }], profiles: [{ id: 'fast', requiredSuiteIds: ['api'] }],
  dependencies: { adapter: 'npm', inputs: ['package-lock.json'], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
  suites: [{ id: 'api', root: 'app', files: ['app/test/*.test.ts'], run: { program: 'node', args: ['runner.js'], cwd: 'app' }, split: { kind: 'argv-files' }, profiles: ['fast'] }],
  impact: { adapter: 'typescript', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } },
  mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' },
};
const files: Record<string, string> = {
  '.hornhoof/test-environment.json': JSON.stringify(manifest),
  'package.json': '{"name":"root"}',
  'package-lock.json': '{"lockfileVersion":3}',
  'README.md': 'Hello',
  'app/src/a.ts': 'export const a = 1;\n',
  'app/src/b.ts': 'export const b = 1;\n',
  'app/test/a.test.ts': "import { a } from '../src/a.js';\nexport { a };\n",
  'app/test/b.test.ts': "import { b } from '../src/b.js';\nexport { b };\n",
};
async function write(root: string, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'hh-print-')); folders.push(root);
  for (const [path, text] of Object.entries(files)) await write(root, path, text);
  git(root, 'init', '--quiet'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'First');
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-print-cache-')); folders.push(cacheRoot);
  const source = { url: pathToFileURL(root).href, token: '' };
  const scope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(source.url).digest('hex') };
  const commit = async (path: string, text: string) => { await write(root, path, text); git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'More'); return git(root, 'rev-parse', 'HEAD'); };
  return { root, source, scope, cacheRoot, head: git(root, 'rev-parse', 'HEAD'), commit, context: { cacheRoot, signal: new AbortController().signal, deadline: Date.now() + 20_000, log: () => {}, runtimes: [{ id: 'node', version: '22.1.0', fingerprint: 'a'.repeat(64) }] } };
}
const printsOf = async (f: Awaited<ReturnType<typeof repository>>, sha: string) => {
  const { fingerprints } = await describeTestEnvironment(f.source, f.scope, sha, f.context);
  return new Map(fingerprints!.map(unit => [unit.file, unit.fingerprint]));
};

describe('fingerprints of a pinned commit', () => {
  it('are the same for the same commit and for a commit that only changes a document', async () => {
    const f = await repository(), first = await printsOf(f, f.head);
    expect([...first.keys()].sort()).toEqual(['app/test/a.test.ts', 'app/test/b.test.ts']);
    expect(await printsOf(f, f.head)).toEqual(first);
    expect(await printsOf(f, await f.commit('README.md', 'Other'))).toEqual(first);
  });

  it('change for the tests of an edited dependency only, and run nothing of the repository', async () => {
    const f = await repository(), first = await printsOf(f, f.head);
    const next = await printsOf(f, await f.commit('app/src/a.ts', 'export const a = 2;\n'));
    expect(next.get('app/test/a.test.ts')).not.toBe(first.get('app/test/a.test.ts'));
    expect(next.get('app/test/b.test.ts')).toBe(first.get('app/test/b.test.ts'));
  });

  it('do not stop a description when they fail', async () => {
    const f = await repository();
    const result = await describeTestEnvironment(f.source, f.scope, f.head, f.context, () => Promise.reject(new Error('Too large.')));
    expect(result.description.commitSha).toBe(f.head);
    expect(result.fingerprints).toBeUndefined();
  });

  it('are left out when they would not fit the reply', async () => {
    const f = await repository(), digest = 'a'.repeat(64);
    const many = Array.from({ length: 10_000 }, (_, index) => ({ suiteId: 'api', file: `app/test/${index}.test.ts`, fingerprint: digest }));
    const result = await describeTestEnvironment(f.source, f.scope, f.head, f.context, () => Promise.resolve(many));
    expect(result.fingerprints).toBeUndefined();
  });

  it('do not hide a cancelled description', async () => {
    const f = await repository(), stop = new AbortController();
    const context = { ...f.context, signal: stop.signal };
    await expect(describeTestEnvironment(f.source, f.scope, f.head, context, () => { stop.abort(); return Promise.reject(new Error('Stopped.')); })).rejects.toThrow();
  });

  it('reach the server with the description', async () => {
    const f = await repository(), emitted: NodeMessage[] = [];
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const dir = await mkdtemp(join(tmpdir(), 'hh-print-node-')); folders.push(dir);
    const messages = new NodeTestMessages({ dir, capabilities: { testEnvironmentVersion: 1, testRuntimes: f.context.runtimes }, stopped: () => false, testing: new Map(), unconfirmed: new Map(), run: async () => {}, emit: message => { emitted.push(message); } });
    await messages.handle({ type: 'tests.describe', requestId: '55555555-5555-4555-8555-555555555555', commitSha: f.head, repo: f.source, repositoryScope: f.scope });
    const reply = TestsDescribed.parse(emitted[0]);
    expect(reply.result).toMatchObject({ status: 'ready', fingerprints: expect.arrayContaining([expect.objectContaining({ suiteId: 'api', file: 'app/test/a.test.ts' })]) });
  });
});

describe('reading many files of a commit at once', () => {
  it('gives each path its text, multi-line and shared alike', async () => {
    const f = await repository();
    await f.commit('app/src/same.ts', files['app/src/a.ts']!);
    const tree = await readCommit(f.source, f.scope, git(f.root, 'rev-parse', 'HEAD'), f.context);
    const texts = await tree.readTexts(['app/src/a.ts', 'app/src/same.ts', 'app/test/a.test.ts'], 1024 * 1024);
    expect(Object.fromEntries(texts)).toEqual({ 'app/src/a.ts': files['app/src/a.ts'], 'app/src/same.ts': files['app/src/a.ts'], 'app/test/a.test.ts': files['app/test/a.test.ts'] });
  });

  it('takes more paths than a pipe holds at once', async () => {
    const f = await repository();
    for (let index = 0; index < 2000; index += 1) await write(f.root, `many/${index}.ts`, `export const value = ${index};\n`);
    const sha = await f.commit('many/last.ts', 'export {};\n');
    const tree = await readCommit(f.source, f.scope, sha, f.context), paths = tree.entries.map(entry => entry.path);
    const texts = await tree.readTexts(paths, 16 * 1024 * 1024);
    expect(texts.size).toBe(paths.length);
    expect(texts.get('many/1999.ts')).toBe('export const value = 1999;\n');
  }, 60_000);

  it('refuses more than its limit and a path the commit does not have', async () => {
    const f = await repository(), tree = await readCommit(f.source, f.scope, f.head, f.context);
    await expect(tree.readTexts(['app/src/a.ts', 'app/src/b.ts'], 8)).rejects.toThrow();
    await expect(tree.readTexts(['app/src/none.ts'], 1024)).rejects.toThrow();
  });
});
