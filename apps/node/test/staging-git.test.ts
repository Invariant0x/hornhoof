import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareStagingCandidate, publishStagingTarget, publishStagingTrial, type StagingGitContext, type StagingGitOptions, type StagingPreparationRequest, type StagingPreparationResult, type StagingTrialPublicationRequest, type StagingTargetPublicationRequest } from '../src/staging-git.js';

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

async function trialFixture() {
  const f = await fixture(), cache = await f.cache(), candidate = await prepareStagingCandidate(f.request, cache.context);
  prepared(candidate);
  const publication: StagingTrialPublicationRequest = { batchId: f.request.batchId, trialId: f.request.trialId, turn: f.request.turn, commitSha: candidate.commitSha };
  return { ...f, ...cache, candidate, publication, fullRef: `refs/tags/${candidate.ref}` };
}

async function targetFixture() {
  const f = await trialFixture();
  expect((await publishStagingTrial(f.publication, f.context)).status).toBe('published');
  const target: StagingTargetPublicationRequest = { ...f.publication, baseSha: f.request.baseSha, target: 'staging' };
  return { ...f, target };
}

describe('ordinary staging and turn fast-forward effects', () => {
  it('publishes the one-commit candidate through staging before turn, with no task branch mutation', async () => {
    const f = await targetFixture(), calls: string[][] = [], real = f.context.git;
    f.context.git = (args, options) => { calls.push(args); return real(args, options); };
    expect(await publishStagingTarget(f.target, f.context)).toEqual({ status: 'published', ref: 'refs/heads/turn-8-staging', commitSha: f.candidate.commitSha });
    expect(await git(f.origin, ['rev-parse', 'refs/heads/turn-8'])).toBe(f.request.baseSha);
    expect(await publishStagingTarget({ ...f.target, target: 'turn' }, f.context)).toEqual({ status: 'published', ref: 'refs/heads/turn-8', commitSha: f.candidate.commitSha });
    expect(await git(f.origin, ['rev-parse', 'refs/heads/turn-8'])).toBe(f.candidate.commitSha);
    expect(await git(f.origin, ['rev-list', '--count', `${f.request.baseSha}..turn-8`])).toBe('1');
    expect(await git(f.origin, ['rev-parse', 'refs/heads/task-a'])).toBe(f.request.heads[0]!.headSha);
    expect(calls.filter(args => args[0] === 'push')).toEqual([
      ['push', '--porcelain', '--no-follow-tags', 'origin', `${f.candidate.commitSha}:refs/heads/turn-8-staging`],
      ['push', '--porcelain', '--no-follow-tags', 'origin', `${f.candidate.commitSha}:refs/heads/turn-8`],
    ]);
  });
  it('does not move turn before the exact candidate is on canonical staging', async () => {
    const f = await targetFixture();
    expect(await publishStagingTarget({ ...f.target, target: 'turn' }, f.context)).toEqual({ status: 'conflict' });
    expect(await git(f.origin, ['rev-parse', 'refs/heads/turn-8'])).toBe(f.request.baseSha);
  });
  it('reconciles a lost push response from independent readback and replays from a new cache without pushing again', async () => {
    const f = await targetFixture(), real = f.context.git;
    f.context.git = async (args, options) => { const result = await real(args, options); return args[0] === 'push' ? { code: 128, stdout: '' } : result; };
    expect((await publishStagingTarget(f.target, f.context)).status).toBe('published');
    const fresh = await f.cache(), calls: string[][] = [], freshGit = fresh.context.git;
    fresh.context.git = (args, options) => { calls.push(args); return freshGit(args, options); };
    expect(await publishStagingTarget(f.target, fresh.context)).toEqual({ status: 'published', ref: 'refs/heads/turn-8-staging', commitSha: f.candidate.commitSha });
    expect(calls.some(args => args[0] === 'push')).toBe(false);
  });
  it('refuses a different current turn pin or canonical staging pin', async () => {
    const f = await targetFixture();
    await git(f.writer, ['push', '--quiet', 'origin', `${f.request.heads[0]!.headSha}:refs/heads/turn-8`]);
    expect(await publishStagingTarget(f.target, f.context)).toEqual({ status: 'conflict' });
    expect(await git(f.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/turn-8-staging'])).toBe('');
    const g = await targetFixture();
    await git(g.writer, ['push', '--quiet', 'origin', `${g.request.heads[0]!.headSha}:refs/heads/turn-8-staging`]);
    expect(await publishStagingTarget(g.target, g.context)).toEqual({ status: 'conflict' });
  });
  it('refuses missing or mismatched immutable trial identity', async () => {
    const f = await trialFixture();
    const target: StagingTargetPublicationRequest = { ...f.publication, baseSha: f.request.baseSha, target: 'staging' };
    expect(await publishStagingTarget(target, f.context)).toEqual({ status: 'conflict' });
    expect((await publishStagingTrial(f.publication, f.context)).status).toBe('published');
    expect(await publishStagingTarget({ ...target, trialId: id(99) }, f.context)).toEqual({ status: 'conflict' });
  });
  it('requires the candidate to have only the registered base as its single parent', async () => {
    const f = await trialFixture();
    const tree = await git(f.bare, ['rev-parse', `${f.candidate.commitSha}^{tree}`]);
    const merge = await rawGit(f.bare, ['commit-tree', tree, '-p', f.request.baseSha, '-p', f.request.heads[0]!.headSha], { input: 'Unapproved two-parent candidate\n' });
    expect(merge.code).toBe(0);
    const source = { ...f.publication, commitSha: merge.stdout.trim() };
    expect((await publishStagingTrial(source, f.context)).status).toBe('published');
    expect(await publishStagingTarget({ ...source, baseSha: f.request.baseSha, target: 'staging' }, f.context)).toEqual({ status: 'conflict' });
  });
  it('does not overwrite a concurrent different fast-forward winner', async () => {
    const f = await targetFixture(), real = f.context.git;
    f.context.git = async (args, options) => {
      if (args[0] === 'push') await git(f.writer, ['push', '--quiet', 'origin', `${f.request.heads[0]!.headSha}:refs/heads/turn-8-staging`]);
      return real(args, options);
    };
    expect(await publishStagingTarget(f.target, f.context)).toEqual({ status: 'conflict' });
    expect(await git(f.origin, ['rev-parse', 'refs/heads/turn-8-staging'])).toBe(f.request.heads[0]!.headSha);
  });
  it('does not call a refused push successful without exact readback', async () => {
    const f = await targetFixture(), real = f.context.git;
    f.context.git = (args, options) => args[0] === 'push' ? Promise.resolve({ code: 128, stdout: '' }) : real(args, options);
    expect(await publishStagingTarget(f.target, f.context)).toEqual({ status: 'unavailable' });
  });
  it('refuses malformed or free-form target refs before touching Git', async () => {
    const f = await targetFixture(); let calls = 0;
    f.context.git = async () => { calls++; return { code: 128, stdout: '' }; };
    expect(await publishStagingTarget({ ...f.target, target: 'main' as 'turn' }, f.context)).toEqual({ status: 'unavailable' });
    expect(calls).toBe(0);
  });
  it('settles the in-flight Git child before rejecting an abort', async () => {
    const f = await targetFixture(), stop = new AbortController(), reason = new Error('Stopped');
    let entered!: () => void, release!: () => void, settled = false;
    const started = new Promise<void>(resolve => { entered = resolve; }); f.context.signal = stop.signal;
    f.context.git = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { code: 128, stdout: '' }; };
    const pending = publishStagingTarget(f.target, f.context); void pending.catch(() => { settled = true; });
    expect(await Promise.race([started.then(() => true), pending.then(() => false)])).toBe(true);
    stop.abort(reason); await Promise.resolve(); expect(settled).toBe(false);
    release(); await expect(pending).rejects.toBe(reason);
  });
});

/* Force the real receive-pack processes to compete, then verify after both have settled. No Git outcome is replaced. */
function pairedPublishers(contexts: [StagingGitContext, StagingGitContext]): void {
  let releaseReads!: () => void, releasePushes!: () => void, reads = 0, pushes = 0;
  const readBarrier = new Promise<void>(resolve => { releaseReads = resolve; });
  const pushBarrier = new Promise<void>(resolve => { releasePushes = resolve; });
  for (const context of contexts) {
    const real = context.git; let firstRead = true;
    context.git = async (args, options) => {
      const result = await real(args, options);
      if (args[0] === 'ls-remote' && firstRead) { firstRead = false; if (++reads === 2) releaseReads(); await readBarrier; }
      if (args[0] === 'push') { if (++pushes === 2) releasePushes(); await pushBarrier; }
      return result;
    };
  }
}

describe('immutable trial tags on disposable Git remotes', () => {
  it('creates only the exact trial tag with ordinary push and exact remote readback', async () => {
    const f = await trialFixture(), calls: string[][] = [], real = f.context.git;
    f.context.git = (args, options) => { calls.push([...args]); return real(args, options); };
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha });
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.candidate.commitSha);
    expect(await git(f.origin, ['rev-parse', 'refs/heads/turn-8'])).toBe(f.request.baseSha);
    expect(calls.filter(args => args[0] === 'push')).toEqual([['push', '--porcelain', '--no-follow-tags', 'origin', `${f.candidate.commitSha}:${f.fullRef}`]]);
  });
  it('replays the same operation without another push or ref update', async () => {
    const f = await trialFixture(), calls: string[][] = [], real = f.context.git;
    f.context.git = (args, options) => { calls.push([...args]); return real(args, options); };
    const expected = { status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha };
    expect(await publishStagingTrial(f.publication, f.context)).toEqual(expected);
    expect(await publishStagingTrial(f.publication, f.context)).toEqual(expected);
    expect(calls.filter(args => args[0] === 'push')).toHaveLength(1);
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.candidate.commitSha);
  });
  it('publishes the exact tag even when an unqualified reader would find a same-name branch', async () => {
    const f = await trialFixture();
    await git(f.writer, ['push', '--quiet', 'origin', `${f.request.baseSha}:refs/heads/${f.candidate.ref}`]);
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha });
    expect(await git(f.origin, ['rev-parse', `refs/heads/${f.candidate.ref}`])).toBe(f.request.baseSha);
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.candidate.commitSha);
  });
  it('refuses to replace a preexisting ancestor even though a branch update would be FF', async () => {
    const f = await trialFixture();
    await git(f.writer, ['push', '--quiet', 'origin', `${f.request.baseSha}:${f.fullRef}`]);
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'conflict' });
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.request.baseSha);
  });
  it('does not overwrite an ancestor created between the initial read and push', async () => {
    const f = await trialFixture(), real = f.context.git; let raced = false;
    f.context.git = async (args, options) => {
      if (args[0] === 'push') { await git(f.writer, ['push', '--quiet', 'origin', `${f.request.baseSha}:${f.fullRef}`]); raced = true; }
      return real(args, options);
    };
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'conflict' });
    expect(raced).toBe(true);
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.request.baseSha);
  });
  it('allows one of two different concurrent candidates and preserves the winner', async () => {
    const f = await trialFixture(), second = await f.cache();
    const candidate = await prepareStagingCandidate({ ...f.request, heads: [...f.request.heads].reverse() }, second.context); prepared(candidate);
    expect(candidate.commitSha).not.toBe(f.candidate.commitSha);
    pairedPublishers([f.context, second.context]);
    const results = await Promise.all([publishStagingTrial(f.publication, f.context), publishStagingTrial({ ...f.publication, commitSha: candidate.commitSha }, second.context)]);
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'published']);
    const winner = results.find(result => result.status === 'published');
    if (winner?.status !== 'published') throw new Error('No candidate was published.');
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(winner.commitSha);
  });
  it('reconciles two concurrent retries of the same deterministic candidate', async () => {
    const f = await trialFixture(), second = await f.cache();
    const candidate = await prepareStagingCandidate(f.request, second.context); prepared(candidate);
    const expected = { status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha };
    pairedPublishers([f.context, second.context]);
    expect(await Promise.all([publishStagingTrial(f.publication, f.context), publishStagingTrial(f.publication, second.context)])).toEqual([expected, expected]);
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.candidate.commitSha);
  });
  it('reconciles a lost push acknowledgment using an independent exact readback', async () => {
    const f = await trialFixture(), real = f.context.git;
    f.context.git = async (args, options) => { const result = await real(args, options); return args[0] === 'push' ? { code: 128, stdout: 'fixture acknowledgment lost' } : result; };
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha });
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.candidate.commitSha);
  });
  it('does not confirm publication without readback and retains the remote ref for retry', async () => {
    const f = await trialFixture(), real = f.context.git; let reads = 0;
    f.context.git = (args, options) => args[0] === 'ls-remote' && ++reads === 2 ? Promise.resolve({ code: 128, stdout: 'private-fixture-marker' }) : real(args, options);
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'unavailable' });
    const remote = await rawGit(f.origin, ['rev-parse', '--verify', f.fullRef]);
    expect({ code: remote.code, sha: remote.stdout.trim() }).toEqual({ code: 0, sha: f.candidate.commitSha });
    f.context.git = real;
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha });
  });
  it('replays an existing exact tag from a fresh cache without relying on old local objects', async () => {
    const f = await trialFixture();
    expect((await publishStagingTrial(f.publication, f.context)).status).toBe('published');
    const fresh = await f.cache();
    expect(await publishStagingTrial(f.publication, fresh.context)).toEqual({ status: 'published', ref: f.fullRef, commitSha: f.candidate.commitSha });
  });
  it('does not publish a noncommit object under a trial tag', async () => {
    const f = await trialFixture(), tree = await git(f.bare, ['rev-parse', `${f.candidate.commitSha}^{tree}`]);
    expect(await publishStagingTrial({ ...f.publication, commitSha: tree }, f.context)).toEqual({ status: 'unavailable' });
    expect(await git(f.origin, ['for-each-ref', '--format=%(refname)', f.fullRef])).toBe('');
  });
  it.each([{ trialId: '../main' }, { turn: 0 }, { commitSha: 'f'.repeat(39) }])('refuses malformed publication input before Git %j', async change => {
    const f = await trialFixture(); let calls = 0;
    f.context.git = async () => { calls++; return { code: 128, stdout: '' }; };
    expect(await publishStagingTrial({ ...f.publication, ...change }, f.context)).toEqual({ status: 'unavailable' }); expect(calls).toBe(0);
  });
  it('keeps a failed Git read opaque and never calls it published', async () => {
    const f = await trialFixture(); f.context.git = async () => ({ code: 128, stdout: 'private-fixture-marker' });
    expect(await publishStagingTrial(f.publication, f.context)).toEqual({ status: 'unavailable' });
  });
  it('does not begin publication after cancellation', async () => {
    const f = await trialFixture(), stop = new AbortController(), reason = new Error('Cancelled before publication');
    stop.abort(reason); f.context.signal = stop.signal;
    await expect(publishStagingTrial(f.publication, f.context)).rejects.toBe(reason);
    expect(await git(f.origin, ['for-each-ref', '--format=%(refname)', f.fullRef])).toBe('');
  });
  it('settles in-flight publication before rejecting cancellation and retains created bytes', async () => {
    const f = await trialFixture(), stop = new AbortController(), reason = new Error('Cancelled while publishing'), real = f.context.git;
    let entered!: () => void, release!: () => void, settled = false;
    const started = new Promise<void>(resolve => { entered = resolve; }); f.context.signal = stop.signal;
    f.context.git = async (args, options) => {
      const result = await real(args, options);
      if (args[0] === 'push') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return result;
    };
    const pending = publishStagingTrial(f.publication, f.context); void pending.catch(() => { settled = true; });
    expect(await Promise.race([started.then(() => true), pending.then(() => false)])).toBe(true);
    stop.abort(reason); await Promise.resolve(); expect(settled).toBe(false);
    release(); await expect(pending).rejects.toBe(reason);
    expect(await git(f.origin, ['rev-parse', f.fullRef])).toBe(f.candidate.commitSha);
  });
});
