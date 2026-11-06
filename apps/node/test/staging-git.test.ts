import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStagingCandidate, type StagingGitContext, type StagingGitOptions, type StagingPreparationRequest, type StagingPreparationResult } from '../src/staging-git.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { name: 'Fixture Publisher', email: 'publisher@example.invalid' };
const createdAt = '2026-11-06T08:00:00.000Z';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true }); });

function rawGit(cwd: string, args: string[], options: StagingGitOptions = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
        GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_DATE: createdAt, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input);
  });
}
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await rawGit(cwd, args);
  if (result.code !== 0) throw new Error(`Fixture Git failed: ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
async function fixture(conflict = false) {
  const root = await mkdtemp(join(tmpdir(), 'hh-staging-fixture-')); roots.push(root);
  const writer = join(root, 'writer'), origin = join(root, 'origin.git');
  await mkdir(writer); await git(writer, ['init', '--quiet', '--initial-branch=main']);
  await writeFile(join(writer, 'left.txt'), 'base left\n'); await writeFile(join(writer, 'right.txt'), 'base right\n');
  await git(writer, ['add', '.']); await git(writer, ['commit', '--quiet', '-m', 'Base']);
  const baseSha = await git(writer, ['rev-parse', 'HEAD']);
  await git(root, ['init', '--quiet', '--bare', origin]); await git(writer, ['remote', 'add', 'origin', origin]);
  await git(writer, ['push', '--quiet', 'origin', 'HEAD:refs/heads/turn-8']);
  await git(writer, ['checkout', '--quiet', '-b', 'task-a', baseSha]);
  await writeFile(join(writer, 'left.txt'), 'accepted left\n'); await git(writer, ['commit', '--quiet', '-am', 'Left']);
  const a = await git(writer, ['rev-parse', 'HEAD']); await git(writer, ['push', '--quiet', 'origin', 'task-a']);
  await git(writer, ['checkout', '--quiet', '-b', 'task-b', baseSha]);
  await writeFile(join(writer, conflict ? 'left.txt' : 'right.txt'), conflict ? 'conflicting left\n' : 'accepted right\n');
  await git(writer, ['commit', '--quiet', '-am', 'Right']);
  const b = await git(writer, ['rev-parse', 'HEAD']); await git(writer, ['push', '--quiet', 'origin', 'task-b']);
  const request: StagingPreparationRequest = { batchId: id(1), trialId: id(2), turn: 8, baseSha, createdAt,
    heads: [{ submissionId: id(3), headSha: a }, { submissionId: id(4), headSha: b }] };
  let cacheNumber = 0;
  const cache = async () => {
    const bare = join(root, `cache-${++cacheNumber}.git`); await git(root, ['init', '--quiet', '--bare', bare]);
    await git(bare, ['remote', 'add', 'origin', origin]);
    const context: StagingGitContext = { identity, signal: new AbortController().signal, git: (args, options) => rawGit(bare, args, options) };
    return { bare, context };
  };
  return { root, writer, origin, request, cache };
}
function prepared(result: StagingPreparationResult): asserts result is Extract<StagingPreparationResult, { status: 'prepared' }> {
  expect(result.status).toBe('prepared');
  if (result.status !== 'prepared') throw new Error('Candidate preparation was refused.');
}

describe('staging candidate preparation on disposable Git remotes', () => {
  it('combines both pinned trees into one commit with only base B as parent, without publishing', async () => {
    const f = await fixture(), { bare, context } = await f.cache();
    const before = await git(f.origin, ['for-each-ref', '--format=%(refname) %(objectname)']);
    const result = await prepareStagingCandidate(f.request, context); prepared(result);
    expect(await git(bare, ['show', `${result.commitSha}:left.txt`])).toBe('accepted left');
    expect(await git(bare, ['show', `${result.commitSha}:right.txt`])).toBe('accepted right');
    expect(await git(bare, ['rev-list', '--count', `${f.request.baseSha}..${result.commitSha}`])).toBe('1');
    expect(await git(bare, ['rev-list', '--parents', '-n', '1', result.commitSha])).toBe(`${result.commitSha} ${f.request.baseSha}`);
    expect((await rawGit(bare, ['merge-base', '--is-ancestor', f.request.heads[0]!.headSha, result.commitSha])).code).toBe(1);
    expect(result.ref).toBe(`turn-8-staging-${id(1)}-${id(2)}`);
    expect(result.members).toEqual([id(3), id(4)]);
    expect(await git(bare, ['rev-parse', `${result.commitSha}^{tree}`])).toBe(result.treeSha);
    expect(await git(f.origin, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
  });
  it('replays to the exact same candidate in a new bare cache', async () => {
    const f = await fixture(), first = await f.cache(), second = await f.cache();
    const a = await prepareStagingCandidate(f.request, first.context); prepared(a);
    const b = await prepareStagingCandidate(f.request, second.context); prepared(b);
    expect(b).toEqual(a);
  });
  it('uses the admitted old H after its task branch moves', async () => {
    const f = await fixture(), { bare, context } = await f.cache();
    await git(f.writer, ['checkout', '--quiet', 'task-a']); await writeFile(join(f.writer, 'left.txt'), 'later unaccepted left\n');
    await git(f.writer, ['commit', '--quiet', '-am', 'Later']); await git(f.writer, ['push', '--quiet', 'origin', 'task-a']);
    const result = await prepareStagingCandidate(f.request, context); prepared(result);
    expect(await git(bare, ['show', `${result.commitSha}:left.txt`])).toBe('accepted left');
  });
  it('reports the conflicting submission without returning Git paths or stderr', async () => {
    const f = await fixture(true), { context } = await f.cache();
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'conflict', submissionId: id(4) });
  });
  it('refuses a source object that the registered remote cannot supply', async () => {
    const f = await fixture(), { context } = await f.cache(); f.request.heads[0]!.headSha = 'f'.repeat(40);
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'unavailable' });
  });
  it('refuses a tree object as the claimed base commit', async () => {
    const f = await fixture(), { context } = await f.cache();
    f.request.baseSha = await git(f.writer, ['rev-parse', `${f.request.baseSha}^{tree}`]);
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'unavailable' });
  });
  it.each([
    { turn: 0 }, { batchId: 'agent-chosen' }, { trialId: '../escape' }, { baseSha: '-uhttps://invalid' },
    { heads: [] }, { heads: [{ submissionId: id(3), headSha: 'f'.repeat(39) }] }, { createdAt: 'today' },
  ])('refuses malformed input before any Git operation %j', async change => {
    const request: StagingPreparationRequest = { batchId: id(1), trialId: id(2), turn: 8, baseSha: 'a'.repeat(40), createdAt,
      heads: [{ submissionId: id(3), headSha: 'b'.repeat(40) }], ...change };
    let calls = 0;
    const context: StagingGitContext = { identity, signal: new AbortController().signal, git: async () => { calls++; return { code: 128, stdout: '' }; } };
    expect(await prepareStagingCandidate(request, context)).toEqual({ status: 'unavailable' }); expect(calls).toBe(0);
  });
  it('refuses duplicate submission identities before touching Git', async () => {
    const f = await fixture(), { context } = await f.cache(); f.request.heads[1]!.submissionId = id(3);
    let calls = 0; context.git = async () => { calls++; return { code: 128, stdout: '' }; };
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'unavailable' }); expect(calls).toBe(0);
  });
  it('does not expose an unexpected executor exception', async () => {
    const f = await fixture(), { context } = await f.cache(); context.git = async () => { throw new Error('private-fixture-marker'); };
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'unavailable' });
  });
  it('does not expose failed Git output or treat it as a candidate', async () => {
    const f = await fixture(), { context } = await f.cache(); context.git = async () => ({ code: 128, stdout: 'private-fixture-marker' });
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'unavailable' });
  });
  it('refuses malformed successful commit-tree output', async () => {
    const f = await fixture(), { context } = await f.cache(), realGit = context.git;
    context.git = (args, options) => args[0] === 'commit-tree' ? Promise.resolve({ code: 0, stdout: 'bad-object-name' }) : realGit(args, options);
    expect(await prepareStagingCandidate(f.request, context)).toEqual({ status: 'unavailable' });
  });
  it('does not start Git after cancellation', async () => {
    const f = await fixture(), { context } = await f.cache(), stop = new AbortController(), reason = new Error('Stopped by owner');
    stop.abort(reason); context.signal = stop.signal; let calls = 0;
    context.git = async () => { calls++; return { code: 0, stdout: '' }; };
    await expect(prepareStagingCandidate(f.request, context)).rejects.toBe(reason); expect(calls).toBe(0);
  });
  it('waits for an in-flight executor to settle before rejecting cancellation', async () => {
    const f = await fixture(), { context } = await f.cache(), stop = new AbortController(), reason = new Error('Stopped in flight');
    let entered!: () => void, release!: () => void, settled = false;
    const started = new Promise<void>(resolve => { entered = resolve; });
    context.signal = stop.signal;
    context.git = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { code: 0, stdout: '' }; };
    const pending = prepareStagingCandidate(f.request, context); void pending.catch(() => { settled = true; });
    expect(await Promise.race([started.then(() => true), pending.then(() => false)])).toBe(true);
    stop.abort(reason); await Promise.resolve(); expect(settled).toBe(false);
    release(); await expect(pending).rejects.toBe(reason);
  });
});
