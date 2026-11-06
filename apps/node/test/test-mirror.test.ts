import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as mirror from '../src/test-mirror.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hh-mirror-')); folders.push(root);
  git(root, 'init', '--quiet'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(root, 'test.txt'), 'version A'); git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'A');
  const first = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'test.txt'), 'version B'); git(root, 'commit', '--quiet', '-am', 'B');
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-mirror-cache-')); folders.push(cacheRoot);
  const source = { url: pathToFileURL(root).href, branch: git(root, 'branch', '--show-current'), token: '' };
  const scope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(source.url).digest('hex') };
  const context = { cacheRoot, signal: new AbortController().signal, deadline: Date.now() + 10_000, log: () => {} };
  return { root, first, source, scope, context };
}

describe('pinned independent checkouts', () => {
  it('retains typed fetch stderr and releases the cache lock and staging before reporting failure', async () => {
    const f = await fixture(), destination = join(f.context.cacheRoot, 'failed-part');
    let error: unknown;
    try { await mirror.checkoutCommit(f.source, f.scope, 'f'.repeat(40), destination, f.context); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ network: true, outcome: { kind: 'child', exitCode: 128, signal: null, stderrTruncated: false } });
    expect((error as { outcome: { stderr: string } }).outcome.stderr.length).toBeGreaterThan(0);
    await expect(access(destination)).rejects.toThrow();
    expect(await mirror.checkoutCommit(f.source, f.scope, f.first, join(f.context.cacheRoot, 'next-part'), f.context)).toBe(f.first);
  });

  it('checks out the old exact SHA after the branch moves with no alternates or shared objects', async () => {
    const f = await fixture(), destination = join(f.context.cacheRoot, 'part');
    expect(await mirror.checkoutCommit(f.source, f.scope, f.first, destination, f.context)).toBe(f.first);
    expect(git(destination, 'rev-parse', 'HEAD')).toBe(f.first);
    expect(await readFile(join(destination, 'test.txt'), 'utf8')).toBe('version A');
    expect(git(destination, 'remote', 'get-url', 'origin')).toBe(f.source.url);
    await expect(access(join(destination, '.git', 'objects', 'info', 'alternates'))).rejects.toThrow();
    const mirrorPath = join(f.context.cacheRoot, f.scope.companyId, f.scope.repositoryOwnerId, f.scope.repoUrlHash, 'mirror.git');
    await rm(mirrorPath, { recursive: true, force: true });
    expect(git(destination, 'show', `${f.first}:test.txt`)).toBe('version A');
  });

  it('reads bounded blobs and tracked modes from the pinned tree without executing its code', async () => {
    const f = await fixture(), tree = await mirror.readCommit(f.source, f.scope, f.first, f.context);
    expect(tree.entries).toEqual([{ path: 'test.txt', mode: '100644', oid: git(f.root, 'rev-parse', `${f.first}:test.txt`) }]);
    expect((await tree.readBlob('test.txt', 64)).toString('utf8')).toBe('version A');
    await expect(tree.readBlob('test.txt', 2)).rejects.toThrow(/limit/i);
    await expect(tree.readBlob('../outside', 64)).rejects.toThrow();
  });

  it('rejects a missing SHA instead of falling back to the current branch', async () => {
    const f = await fixture();
    await expect(mirror.checkoutCommit(f.source, f.scope, 'f'.repeat(40), join(f.context.cacheRoot, 'part'), f.context)).rejects.toThrow(/commit|fetch/i);
    await expect(access(join(f.context.cacheRoot, 'part', 'test.txt'))).rejects.toThrow();
  });

  it('serializes overlapping fetches and stores no source credentials or source remote in the mirror', async () => {
    const f = await fixture();
    const results = await Promise.all([mirror.checkoutCommit(f.source, f.scope, f.first, join(f.context.cacheRoot, 'one'), f.context), mirror.checkoutCommit(f.source, f.scope, f.first, join(f.context.cacheRoot, 'two'), f.context)]);
    expect(results).toEqual([f.first, f.first]);
    const config = await readFile(join(f.context.cacheRoot, f.scope.companyId, f.scope.repositoryOwnerId, f.scope.repoUrlHash, 'mirror.git', 'config'), 'utf8');
    expect(config).not.toContain(f.source.url); expect(config).not.toContain('remote');
  });

  it('rejects a mismatched repository scope and a non-40-character product SHA', async () => {
    const f = await fixture(), destination = join(f.context.cacheRoot, 'part');
    await expect(mirror.checkoutCommit(f.source, { ...f.scope, repoUrlHash: 'a'.repeat(64) }, f.first, destination, f.context)).rejects.toThrow(/scope/i);
    await expect(mirror.checkoutCommit(f.source, f.scope, 'a'.repeat(64), destination, f.context)).rejects.toThrow(/commit/i);
  });
});


it('leaves an existing destination intact when checkout is refused', async () => {
  const f = await fixture(), destination = join(f.context.cacheRoot, 'part');
  await mirror.checkoutCommit(f.source, f.scope, f.first, destination, f.context);
  await writeFile(join(destination, 'sentinel'), 'keep');
  await expect(mirror.checkoutCommit(f.source, f.scope, f.first, destination, f.context)).rejects.toThrow();
  expect(await readFile(join(destination, 'sentinel'), 'utf8')).toBe('keep');
});
