import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryPath, RepositoryScope, type Workspace } from '@hornhoof/protocol';
import { cacheLockDescriptors, checkCacheContext, privateCacheRoot, withCacheLock, type CacheContext } from './test-cache.js';
import { gitEnv, gitPreparationFailure } from './workspace.js';
import { StreamMask } from './terminal/mask.js';

type Source = Pick<NonNullable<Workspace['repo']>, 'url' | 'token'>;
export type GitEntry = { path: string; mode: string; oid: string };
export type CommitTree = { commitSha: string; entries: GitEntry[]; readBlob: (path: string, limit: number) => Promise<Buffer> };
const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.logAllRefUpdates=false', '-c', 'protocol.ext.allow=never'];

function stopGit(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function gitBytes(args: string[], context: CacheContext, limit = 3 * 1024 * 1024, auth: Record<string, string> = {}, network = false): Promise<Buffer> {
  checkCacheContext(context);
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, context.deadline - Date.now()))]);
    const child = spawn('/usr/bin/git', [...GIT_FLAGS, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe', ...cacheLockDescriptors()], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: context.cacheRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...auth } });
    const chunks: Buffer[] = []; let size = 0, failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const mask = new StreamMask(() => [auth.HH_GIT_PASSWORD ?? '']);
    let stderr = '', stderrTruncated = false;
    const capture = (text: string) => { const combined = stderr + text; stderrTruncated ||= combined.length > 8192; stderr = combined.slice(-8192); };
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => capture(mask.push(text)));
    const stop = () => {
      stopGit(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => stopGit(child.pid, 'SIGKILL'), 5000); killTimer.unref();
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { failure = new Error('Git output exceeds the configured limit.'); stop(); }
      else chunks.push(chunk);
    });
    child.once('error', error => { failure = error; });
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    child.once('close', (code, signalName) => {
      signal.removeEventListener('abort', stop); clearTimeout(killTimer); stopGit(child.pid, 'SIGKILL');
      capture(mask.flush());
      if (signal.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(gitPreparationFailure({ kind: 'child', exitCode: code, signal: signalName, osCode: null, stderr, stderrTruncated }, network, [auth.HH_GIT_PASSWORD ?? '']));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export async function repositoryCacheRoot(source: Pick<Source, 'url'>, scope: RepositoryScope, context: CacheContext): Promise<string> {
  RepositoryScope.parse(scope);
  const url = new URL(source.url);
  if (url.username || url.password) throw new Error('Repository credentials must be supplied separately.');
  if (createHash('sha256').update(source.url).digest('hex') !== scope.repoUrlHash) throw new Error('The repository scope does not match its source.');
  let root = await privateCacheRoot(context.cacheRoot);
  for (const component of [scope.companyId, scope.repositoryOwnerId, scope.repoUrlHash]) root = await privateCacheRoot(join(root, component));
  return root;
}
function pinnedCommit(commitSha: string): void {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('An exact lowercase 40-character commit SHA is required.');
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function mirrorAt(source: Source, scope: RepositoryScope, commitSha: string, context: CacheContext, use: (mirror: string) => Promise<void>): Promise<string> {
  pinnedCommit(commitSha);
  const root = await repositoryCacheRoot(source, scope, context), mirror = join(root, 'mirror.git');
  await mkdir(join(root, 'locks'), { recursive: true, mode: 0o700 });
  await withCacheLock(join(root, 'locks', 'mirror'), context, async () => {
    if (!(await exists(mirror))) await gitBytes(['init', '--bare', '--template=', '--', mirror], context);
    if (!(await lstat(mirror)).isDirectory()) throw new Error('The repository mirror is not a private directory.');
    const hasCommit = await gitBytes(['--git-dir', mirror, 'cat-file', '-e', `${commitSha}^{commit}`], context).then(() => true, () => false);
    if (!hasCommit) await gitBytes(['--git-dir', mirror, 'fetch', '--no-tags', '--no-recurse-submodules', '--', source.url, commitSha], context, 1024, gitEnv(source), true);
    const actual = (await gitBytes(['--git-dir', mirror, 'rev-parse', '--verify', `${commitSha}^{commit}`], context)).toString('ascii').trim();
    if (actual !== commitSha) throw new Error('The mirror returned a different commit.');
    await gitBytes(['--git-dir', mirror, 'update-ref', `refs/hornhoof/pins/${commitSha}`, commitSha], context);
    await use(mirror);
  });
  return mirror;
}

export async function checkoutCommit(source: Source, scope: RepositoryScope, commitSha: string, destination: string, context: CacheContext): Promise<string> {
  await mkdir(destination, { mode: 0o700 });
  try {
    await mirrorAt(source, scope, commitSha, context, async mirror => {
      await gitBytes(['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--template=', '--', mirror, destination], context);
      if (await exists(join(destination, '.git', 'objects', 'info', 'alternates'))) throw new Error('A test checkout must have independent Git objects.');
      await gitBytes(['-C', destination, 'remote', 'set-url', 'origin', source.url], context);
      await gitBytes(['-C', destination, 'checkout', '--quiet', '--detach', commitSha, '--'], context);
      const actual = (await gitBytes(['-C', destination, 'rev-parse', 'HEAD'], context)).toString('ascii').trim();
      if (actual !== commitSha) throw new Error('The test checkout differs from its pinned commit.');
    });
    return commitSha;
  } catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
}

function treeEntries(output: Buffer): GitEntry[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(output), result: GitEntry[] = [];
  for (const record of text.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Unsupported Git tree metadata.');
    RepositoryPath.parse(match[3]); result.push({ path: match[3], mode: match[1], oid: match[2] });
  }
  if (result.length > 10_000) throw new Error('The tracked inventory exceeds its 10000-entry limit.');
  return result;
}
export async function readCommit(source: Source, scope: RepositoryScope, commitSha: string, context: CacheContext): Promise<CommitTree> {
  let entries: GitEntry[] = [];
  const mirror = await mirrorAt(source, scope, commitSha, context, async path => { entries = treeEntries(await gitBytes(['--git-dir', path, 'ls-tree', '-rz', '--full-tree', commitSha], context)); });
  return { commitSha, entries, readBlob: async (path, limit) => {
    RepositoryPath.parse(path);
    const entry = entries.find(item => item.path === path);
    if (!entry || !['100644', '100755'].includes(entry.mode)) throw new Error('The description requires a tracked regular file.');
    return gitBytes(['--git-dir', mirror, 'cat-file', 'blob', entry.oid], context, limit);
  } };
}
