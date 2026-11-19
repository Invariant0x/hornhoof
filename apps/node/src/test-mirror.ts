import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { RepositoryPath, RepositoryScope, type AuthorCheckRun, type Workspace } from '@hornhoof/protocol';
import { cacheLockDescriptors, checkCacheContext, privateCacheRoot, withCacheLock, type CacheContext } from './test-cache.js';
import { deadlineSignal } from './test-context.js';
import { GitCredentialMask, gitEnv, gitPreparationFailure, type GitPreparationError } from './workspace.js';
import type { MutationDelta } from './test-impact-mutation.js';
import { matchingAuthorPatch } from './author-patch.js';
import { signalProcessGroup } from './process-group.js';

type Source = Pick<NonNullable<Workspace['repo']>, 'url' | 'token'>;
export type GitEntry = { path: string; mode: string; oid: string };
export type CommitTree = { commitSha: string; entries: GitEntry[]; readBlob: (path: string, limit: number) => Promise<Buffer>; readBlobs: (paths: string[], limit: number, use: (path: string, bytes: Buffer) => void) => Promise<void>; readTexts: (paths: string[], limit: number) => Promise<Map<string, string>> };
const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.logAllRefUpdates=false', '-c', 'protocol.ext.allow=never'];

function stopGit(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  signalProcessGroup(pid, signal);
}

function gitCancellation(error: GitPreparationError, stopped: AbortSignal): Error {
  if (!stopped.aborted) return error;
  const timeout = stopped.reason instanceof DOMException && stopped.reason.name === 'TimeoutError';
  return Object.assign(new DOMException(error.message, timeout ? 'TimeoutError' : 'AbortError'), { outcome: error.outcome, network: error.network, stopped: timeout ? 'timeout' : 'cancelled' });
}

function failedGit(code: number | null, signal: NodeJS.Signals | null, failure: Error | undefined, stopped: AbortSignal, stderr: string, stderrTruncated: boolean, network: boolean, secrets: string[]): Error {
  const osCode = (failure as NodeJS.ErrnoException | undefined)?.code ?? null;
  const action = network ? 'fetch' : 'local';
  const error = gitPreparationFailure({ kind: 'child', exitCode: code !== null && code >= 0 ? code : null, signal, osCode, stderr, stderrTruncated }, network, secrets, action);
  if (failure) error.message = gitPreparationFailure({ ...error.outcome, stderr: failure.message }, network, secrets, action).message;
  return gitCancellation(error, stopped);
}

type GitOutput = { auth?: Record<string, string>; network?: boolean; input?: string | Buffer };
const TOO_MUCH = 'Git output exceeds the configured limit.';
/* Runs git and hands over what it prints as it comes; whatever take throws stops it, and is what the run fails with. */
function gitStream(args: string[], context: CacheContext, take: (chunk: Buffer) => void, { auth = {}, network = false, input }: GitOutput = {}): Promise<void> {
  checkCacheContext(context);
  return new Promise((resolve, reject) => {
    const signal = deadlineSignal(context.signal, context.deadline);
    const child = spawn('/usr/bin/git', [...GIT_FLAGS, ...args], { detached: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', ...cacheLockDescriptors()], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: context.cacheRoot, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...auth } });
    let failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const secret = auth.HH_GIT_PASSWORD ?? '', mask = new GitCredentialMask([secret]);
    let stderr = '', stderrTruncated = false;
    const capture = (text: string) => { const combined = stderr + text; stderrTruncated ||= combined.length > 8192; stderr = combined.slice(-8192); };
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (text: string) => capture(mask.push(text)));
    const stop = () => {
      stopGit(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => stopGit(child.pid, 'SIGKILL'), 5000); killTimer.unref();
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      try { take(chunk); }
      catch (error) { failure ??= error as Error; stop(); }
    });
    // A git that stops early closes this pipe: how it ended says what went wrong.
    child.stdin?.on('error', () => {}).end(input);
    child.once('error', error => { failure = error; });
    signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    child.once('close', (code, signalName) => {
      signal.removeEventListener('abort', stop); clearTimeout(killTimer); stopGit(child.pid, 'SIGKILL');
      capture(mask.flush());
      if (signal.aborted || failure || code !== 0) reject(failedGit(code, signalName, failure, signal, stderr, stderrTruncated, network, [secret]));
      else resolve();
    });
  });
}

function gitBytes(args: string[], context: CacheContext, limit = 3 * 1024 * 1024, auth: Record<string, string> = {}, network = false): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  return gitStream(args, context, chunk => {
    size += chunk.length;
    if (size > limit) throw new Error(TOO_MUCH);
    chunks.push(chunk);
  }, { auth, network }).then(() => Buffer.concat(chunks));
}

/* Root-relative literal pathspecs let Git compare the driver without making its files inputs to the mirror's fingerprint. */
const AUTHOR_DRIVER_PATHSPECS = [
  ':(top,literal)scripts/author-check.mjs',
  ':(top,literal)scripts/author-check',
  ':(top,literal)scripts/test/tracked-files.mjs',
];

function authorGit(mirror: string, context: CacheContext) {
  return async (args: string[], input?: Buffer): Promise<Buffer> => {
    if (!input) return gitBytes(['--literal-pathspecs', '--git-dir', mirror, ...args], context, 16 * 1024 * 1024);
    const chunks: Buffer[] = [];
    await gitStream(args, context, chunk => chunks.push(chunk), { input });
    return Buffer.concat(chunks);
  };
}

/* Compare server-pinned objects inside the node's Git mirror before any candidate code can run. */
export async function authorComparison(run: AuthorCheckRun, context: CacheContext): Promise<string | null> {
  const { repo, repositoryScope: scope, pin } = run;
  await mirrorAt(repo, scope, pin.baseCommit, context, async () => {});
  if (run.mainCommit !== pin.baseCommit) await mirrorAt(repo, scope, run.mainCommit, context, async () => {});
  let cherryPick: string | null = null;
  await mirrorAt(repo, scope, pin.commit, context, async mirror => {
    const args = ['--git-dir', mirror];
    await gitBytes([...args, 'merge-base', '--is-ancestor', pin.baseCommit, pin.commit], context);
    const driver = await gitBytes([...args, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', pin.baseCommit, pin.commit, '--', ...AUTHOR_DRIVER_PATHSPECS], context);
    if (driver.length) throw new Error('The change edits the author-check driver.');
    if (run.verifyCherryPick) cherryPick = await matchingAuthorPatch(pin, run.mainCommit, authorGit(mirror, context));
  });
  return cherryPick;
}

async function repositoryCacheRoot(source: Pick<Source, 'url'>, scope: RepositoryScope, context: CacheContext): Promise<string> {
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
/* What asks for a file asks by path, and one commit may be asked for all it tracks. */
function regularOids(entries: GitEntry[]): (path: string) => string {
  const oids = new Map(entries.filter(entry => ['100644', '100755'].includes(entry.mode)).map(entry => [entry.path, entry.oid]));
  return path => {
    RepositoryPath.parse(path);
    const oid = oids.get(path);
    if (!oid) throw new Error('The description requires a tracked regular file.');
    return oid;
  };
}
/* Parts what `git cat-file --batch` prints into its files, each held only while it is used. */
class BlobOutput {
  private held: Buffer = Buffer.alloc(0);
  private next = 0;
  constructor(private readonly paths: string[], private readonly limit: number, private readonly use: (path: string, bytes: Buffer) => void) {}
  private oneFile(): boolean {
    const end = this.held.indexOf(10);
    if (end < 0) return false;
    const size = /^[a-f0-9]{40} blob (\d+)$/.exec(this.held.toString('latin1', 0, end))?.[1];
    if (size === undefined) throw new Error('Unsupported Git blob output.');
    if (Number(size) > this.limit) throw new Error(TOO_MUCH);
    const after = end + 1 + Number(size);
    if (this.held.length <= after) return false;
    this.use(this.paths[this.next++]!, this.held.subarray(end + 1, after));
    this.held = this.held.subarray(after + 1);
    return this.held.length > 0;
  }
  push(chunk: Buffer): void {
    this.held = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    while (this.oneFile());
  }
  get whole(): boolean { return this.next === this.paths.length && !this.held.length; }
}
export async function readCommit(source: Source, scope: RepositoryScope, commitSha: string, context: CacheContext): Promise<CommitTree> {
  let entries: GitEntry[] = [];
  const mirror = await mirrorAt(source, scope, commitSha, context, async path => { entries = treeEntries(await gitBytes(['--git-dir', path, 'ls-tree', '-rz', '--full-tree', commitSha], context)); });
  const oidOf = regularOids(entries);
  const readBlobs: CommitTree['readBlobs'] = async (paths, limit, use) => {
    const wanted = paths.map(oidOf), output = new BlobOutput(paths, limit, use);
    if (!wanted.length) return;
    await gitStream(['--git-dir', mirror, 'cat-file', '--batch'], context, chunk => output.push(chunk), { input: wanted.map(oid => `${oid}\n`).join('') });
    if (!output.whole) throw new Error('Git did not print every file asked for.');
  };
  return { commitSha, entries, readBlob: async (path, limit) => gitBytes(['--git-dir', mirror, 'cat-file', 'blob', oidOf(path)], context, limit), readBlobs, readTexts: async (paths, limit) => {
    const texts = new Map<string, string>();
    let size = 0;
    await readBlobs(paths, limit, (path, bytes) => {
      size += bytes.length;
      if (size > limit) throw new Error(TOO_MUCH);
      texts.set(path, bytes.toString('utf8'));
    });
    return texts;
  } };
}

/* Compare the pinned objects, without checkout filters, text converters, hooks or repository commands. Reading each
   literal source separately avoids interpreting quoted Git path headers as repository paths. */
export async function readMutationDelta(source: Source, scope: RepositoryScope, baseCommit: string, commit: string, paths: string[], context: CacheContext): Promise<MutationDelta> {
  await mirrorAt(source, scope, baseCommit, context, async () => {});
  const changes: MutationDelta['changes'] = [];
  await mirrorAt(source, scope, commit, context, async mirror => {
    await gitBytes(['--git-dir', mirror, 'merge-base', '--is-ancestor', baseCommit, commit], context);
    for (const path of [...new Set(paths)].sort()) {
      RepositoryPath.parse(path);
      const diff = await gitBytes(['--literal-pathspecs', '--git-dir', mirror, 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', baseCommit, commit, '--', path], context);
      if (!diff.length) continue;
      const ranges: [number, number][] = [...diff.toString('utf8').matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
        .map(match => [Number(match[1]), Number(match[2] ?? 1)] as [number, number]).filter(([, count]) => count > 0);
      changes.push({ path, ranges });
    }
  });
  return { baseCommit, commit, changes };
}
