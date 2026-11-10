import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExternalConsumer, ExternalGitIntent, ExternalGitOutcome } from '@hornhoof/protocol';
import { fetchTarget } from '../src/external-git.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { baseEnv, BINDING, calls, type Env, FakePort, head, inProcess, JOB, planFor, realGit, refusingBridge, remoteRef, REPOSITORY, runShim, scriptedBridge, serve, SHIM, shim, type Stand, stand } from './external-git-helpers.js';

describe('hh-git as plain git', () => {
  it('passes any other command through with its output and exit code', async () => {
    const s = stand();
    const ran = await runShim(['rev-parse', '--abbrev-ref', 'HEAD'], s.work, baseEnv(s));
    expect(ran).toEqual({ stdout: 'task-1\n', stderr: '', code: 0 });
    const failed = await runShim(['rev-parse', '--verify', 'no-such-ref'], s.work, baseEnv(s));
    expect(failed.code).toBe(128);
    expect(failed.stderr).toContain('fatal: Needed a single revision');
  });

  it('keeps an ordinary push plain outside a Hornhoof terminal', async () => {
    const s = stand();
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, baseEnv(s));
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain('task-1 -> task-1');
    expect(ran.stderr).not.toContain('hornhoof-git');
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
  });

  it('leaves a folder that is gone for real git to report', async () => {
    const s = stand();
    const gone = join(s.dir, 'gone');
    mkdirSync(gone);
    const done = spawnSync('/bin/sh', ['-c', `cd '${gone}' && rmdir '${gone}' && exec '${process.execPath}' '${SHIM}' status`], { env: baseEnv(s) as NodeJS.ProcessEnv, encoding: 'utf8' });
    expect(done.stderr).toContain('fatal:');
    expect(done.stderr).not.toContain('uv_cwd');
    expect(done.status).toBe(128);
  });

  it('runs a plain command inside the program with its own exit code', async () => {
    const s = stand();
    expect(await inProcess(['status', '--porcelain'], s.work, baseEnv(s))).toEqual({ stdout: '', stderr: '', code: 0 });
    expect((await inProcess(['rev-parse', '--verify', '--quiet', 'no-such-ref'], s.work, baseEnv(s))).code).toBe(1);
    expect(process.listenerCount('SIGHUP')).toBe(0);
  });

  it('gives a missing git binary the shell code for it', async () => {
    const s = stand();
    const ran = await inProcess(['status'], s.work, baseEnv(s, { HH_REAL_GIT: join(s.dir, 'no-such-git') }));
    expect(ran.code).toBe(127);
    expect(ran.stderr).toContain('no-such-git');
  });

  it('ends with the code of a signal that stopped real git', async () => {
    const s = stand();
    planFor(s, { status: [{ do: 'hang' }] });
    const ran = runShim(['status'], s.work, baseEnv(s));
    await eventually(() => calls(s, 'status').length === 1);
    await eventually(() => ran.partial().stderr.includes('still working'));
    ran.signal('SIGTERM');
    const ended = await ran;
    expect(ended.code).toBe(143);
  });
});

describe('which git calls are managed', () => {
  const env: Env = { HH_BRIDGE: 'http://127.0.0.1:1/hook/secret', PATH: '/usr/bin' };

  it.each([
    ['status'], ['commit', '-m', 'push'], ['log', '--grep', 'fetch'], ['-C', '/tmp', 'status'],
  ])('leaves %s alone', (...argv) => {
    expect(shim.routeGit(argv, env, '/work')).toEqual({ kind: 'plain' });
  });

  it.each<[string, string[], Env?]>([
    ['no_bridge', ['push', 'origin', 'task-1'], { PATH: '/usr/bin' }],
    ['nested', ['push', 'origin', 'task-1'], { ...env, HH_GIT_NESTED: '1' }],
    ['global_option', ['-c', 'http.proxy=x', 'push', 'origin', 'task-1']],
    ['global_option', ['--git-dir=/x', 'fetch', 'origin', 'main']],
    ['custom_environment', ['push', 'origin', 'task-1'], { ...env, GIT_SSH_COMMAND: 'x' }],
    ['custom_environment', ['fetch', 'origin', 'main'], { ...env, GIT_DIR: '/x' }],
    ['force', ['push', '-f', 'origin', 'task-1']],
    ['force', ['push', '--force', 'origin', 'task-1']],
    ['force', ['push', '--force-with-lease', 'origin', 'task-1']],
    ['force', ['push', '--force-if-includes', 'origin', 'task-1']],
    ['force', ['push', 'origin', '+task-1:task-1']],
    ['force', ['fetch', '-f', 'origin', 'main']],
    ['force', ['fetch', 'origin', '+refs/heads/a:refs/remotes/origin/a']],
    ['delete', ['push', '-d', 'origin', 'task-1']],
    ['delete', ['push', '--delete', 'origin', 'task-1']],
    ['delete', ['push', 'origin', ':task-1']],
    ['multi_ref', ['push', '--all', 'origin']],
    ['multi_ref', ['push', '--branches', 'origin']],
    ['multi_ref', ['push', '--mirror', 'origin']],
    ['multi_ref', ['push', '--tags', 'origin']],
    ['multi_ref', ['push', '--follow-tags', 'origin', 'task-1']],
    ['multi_ref', ['push', '--prune', 'origin']],
    ['multi_ref', ['push', 'origin', 'a', 'b']],
    ['multi_ref', ['fetch', '--all']],
    ['multi_ref', ['fetch', '--multiple', 'origin', 'other']],
    ['multi_ref', ['fetch', 'origin', 'a', 'b']],
    ['dry_run', ['push', '-n', 'origin', 'task-1']],
    ['dry_run', ['push', '--dry-run', 'origin', 'task-1']],
    ['dry_run', ['fetch', '--dry-run', 'origin', 'main']],
    ['custom_transport', ['push', '--receive-pack=x', 'origin', 'task-1']],
    ['custom_transport', ['push', '--exec=x', 'origin', 'task-1']],
    ['custom_transport', ['push', '--repo=x', 'task-1']],
    ['custom_transport', ['fetch', '--upload-pack=x', 'origin', 'main']],
    ['option', ['push', '-o', 'ci.skip', 'origin', 'task-1']],
    ['option', ['push', '--', 'origin', 'task-1']],
    ['option', ['fetch', '--depth=1', 'origin', 'main']],
    ['option', ['fetch', '--prune', 'origin', 'main']],
    ['dynamic_refspec', ['fetch', 'origin', 'refs/heads/*:refs/remotes/origin/*']],
    ['dynamic_refspec', ['push', 'origin', 'refs/heads/*:refs/heads/*']],
    ['dynamic_refspec', ['fetch', 'origin', ':refs/heads/x']],
  ])('names %s for %j', (reason, argv, given) => {
    expect(shim.routeGit(argv, given ?? env, '/work')).toEqual({ kind: 'unmanaged', reason });
  });

  it('lists every reason it can give, in plain words', () => {
    for (const reason of ['no_bridge', 'nested', 'global_option', 'custom_environment', 'force', 'delete', 'multi_ref', 'dry_run', 'custom_transport', 'option', 'dynamic_refspec', 'url_remote', 'multi_target', 'configured_refspec', 'no_current_branch', 'no_upstream', 'ambiguous_default', 'unknown_source', 'other_ref', 'no_destination', 'ambiguous_fetch']) {
      expect(shim.UNMANAGED[reason]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('reads the options it keeps and the folder of -C', () => {
    expect(shim.routeGit(['-C', 'sub', 'push', '-u', '-q', 'origin', 'task-1'], env, '/work')).toEqual({ kind: 'push', cwd: '/work/sub', remote: 'origin', refspec: 'task-1', flags: ['--quiet'], setUpstream: true });
    expect(shim.routeGit(['push', '--verbose', '--no-progress', '--porcelain', '--no-verify'], env, '/work')).toEqual({ kind: 'push', cwd: '/work', remote: null, refspec: null, flags: ['--verbose', '--no-progress', '--porcelain', '--no-verify'], setUpstream: false });
    expect(shim.routeGit(['fetch', '-q', '--progress', '-n', 'origin', 'turn-8'], env, '/work')).toEqual({ kind: 'fetch', cwd: '/work', remote: 'origin', refspec: 'turn-8', flags: ['--quiet', '--progress', '--no-tags'] });
  });

  it('takes a fetch without a refspec as a fetch by the settings of the remote', () => {
    expect(shim.routeGit(['fetch'], env, '/work')).toEqual({ kind: 'fetch_configured', cwd: '/work', remote: null, flags: [] });
    expect(shim.routeGit(['fetch', '-q', 'origin'], env, '/work')).toEqual({ kind: 'fetch_configured', cwd: '/work', remote: 'origin', flags: ['--quiet'] });
  });

  it('allows the author and prompt settings of an ordinary turn', () => {
    const turn = { ...env, GIT_ASKPASS: '/app/git-askpass', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b' };
    expect(shim.routeGit(['push', 'origin', 'task-1'], turn, '/work').kind).toBe('push');
  });
});

describe('the immutable intent of a push', () => {
  const env: Env = { HH_BRIDGE: 'http://127.0.0.1:1/hook/secret', PATH: process.env.PATH };
  const resolve = (s: Stand, ...argv: string[]) => shim.resolveRequest(shim.routeGit(argv, env, s.work), { ...env, HH_REAL_GIT: '/usr/bin/git' });
  const pinned = (s: Stand, destinationRef: string, extra: object = {}) => ({ request: { kind: 'push', cwd: s.work, remote: 'origin', sourceSha: head(s), destinationRef, upstreamBranch: null, flags: [], ...extra } });

  it('pins a named branch to its commit and its own full ref', () => {
    const s = stand();
    expect(resolve(s, 'push', 'origin', 'task-1')).toEqual(pinned(s, 'refs/heads/task-1'));
    expect(resolve(s, 'push', 'origin', 'refs/heads/task-1')).toEqual(pinned(s, 'refs/heads/task-1'));
    expect(resolve(s, 'push', 'origin', 'HEAD')).toEqual(pinned(s, 'refs/heads/task-1'));
  });

  it('pins an explicit target', () => {
    const s = stand();
    expect(resolve(s, 'push', 'origin', 'HEAD:refs/heads/turn-8')).toEqual(pinned(s, 'refs/heads/turn-8'));
    expect(resolve(s, 'push', 'origin', 'task-1:other')).toEqual(pinned(s, 'refs/heads/other'));
    expect(resolve(s, 'push', 'origin', `${head(s)}:refs/heads/other`)).toEqual(pinned(s, 'refs/heads/other'));
    expect(resolve(s, 'push', '-q', 'origin', 'task-1')).toEqual(pinned(s, 'refs/heads/task-1', { flags: ['--quiet'] }));
  });

  it('keeps the branch to track when -u asks for it', () => {
    const s = stand();
    expect(resolve(s, 'push', '-u', 'origin', 'task-1')).toEqual(pinned(s, 'refs/heads/task-1', { upstreamBranch: 'task-1' }));
    expect(resolve(s, 'push', '-u', 'origin', `${head(s)}:refs/heads/x`)).toEqual(pinned(s, 'refs/heads/x'));
  });

  it('resolves a default push from the current settings to one target', () => {
    const s = stand();
    realGit(s.work, 'config', 'branch.task-1.remote', 'origin');
    realGit(s.work, 'config', 'branch.task-1.merge', 'refs/heads/task-1');
    expect(resolve(s, 'push')).toEqual(pinned(s, 'refs/heads/task-1'));
    expect(resolve(s, 'push', 'origin')).toEqual(pinned(s, 'refs/heads/task-1'));
  });

  it('follows push.default upstream to another branch name', () => {
    const s = stand();
    realGit(s.work, 'config', 'push.default', 'upstream');
    realGit(s.work, 'config', 'branch.task-1.remote', 'origin');
    realGit(s.work, 'config', 'branch.task-1.merge', 'refs/heads/shared');
    expect(resolve(s, 'push')).toEqual(pinned(s, 'refs/heads/shared'));
  });

  it('follows push.default current without an upstream', () => {
    const s = stand();
    realGit(s.work, 'config', 'push.default', 'current');
    expect(resolve(s, 'push')).toEqual(pinned(s, 'refs/heads/task-1'));
  });

  it('pushes to the same name on another remote than the upstream', () => {
    const s = stand();
    realGit(s.work, 'remote', 'add', 'second', s.url);
    realGit(s.work, 'config', 'branch.task-1.remote', 'origin');
    realGit(s.work, 'config', 'branch.task-1.merge', 'refs/heads/task-1');
    expect(resolve(s, 'push', 'second')).toEqual({ request: { ...pinned(s, 'refs/heads/task-1').request, remote: 'second' } });
    realGit(s.work, 'config', 'remote.pushDefault', 'second');
    expect(resolve(s, 'push')).toEqual({ request: { ...pinned(s, 'refs/heads/task-1').request, remote: 'second' } });
  });

  it('sets up tracking for a default push when push.autoSetupRemote says so', () => {
    const s = stand();
    realGit(s.work, 'config', 'push.autoSetupRemote', 'true');
    expect(resolve(s, 'push')).toEqual(pinned(s, 'refs/heads/task-1', { upstreamBranch: 'task-1' }));
  });

  it.each<[string, (s: Stand) => void, string[]]>([
    ['no_upstream', () => {}, ['push']],
    ['no_upstream', s => { realGit(s.work, 'config', 'push.default', 'upstream'); }, ['push']],
    ['ambiguous_default', s => { realGit(s.work, 'config', 'push.default', 'matching'); }, ['push']],
    ['ambiguous_default', s => { realGit(s.work, 'config', 'push.default', 'nothing'); }, ['push']],
    ['ambiguous_default', s => { realGit(s.work, 'config', 'branch.task-1.remote', 'origin'); realGit(s.work, 'config', 'branch.task-1.merge', 'refs/heads/other'); }, ['push']],
    ['ambiguous_default', s => { realGit(s.work, 'remote', 'add', 'second', s.url); realGit(s.work, 'config', 'push.default', 'upstream'); realGit(s.work, 'config', 'branch.task-1.remote', 'second'); realGit(s.work, 'config', 'branch.task-1.merge', 'refs/heads/task-1'); }, ['push', 'origin']],
    ['no_current_branch', s => { realGit(s.work, 'checkout', '--quiet', '--detach'); }, ['push']],
    ['no_destination', s => { realGit(s.work, 'checkout', '--quiet', '--detach'); }, ['push', 'origin', 'HEAD']],
    ['no_destination', s => { realGit(s.work, 'checkout', '--quiet', '--detach'); }, ['push', 'origin', 'HEAD:short']],
    ['url_remote', () => {}, ['push', 'file:///elsewhere.git', 'task-1']],
    ['url_remote', () => {}, ['fetch', 'file:///elsewhere.git', 'main']],
    ['multi_target', s => { realGit(s.work, 'remote', 'set-url', '--add', '--push', 'origin', s.url); realGit(s.work, 'remote', 'set-url', '--add', '--push', 'origin', `${s.url}.two`); }, ['push', 'origin', 'task-1']],
    ['configured_refspec', s => { realGit(s.work, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/x/*'); }, ['push', 'origin', 'task-1']],
    ['multi_ref', s => { realGit(s.work, 'config', 'remote.origin.mirror', 'true'); }, ['push', 'origin', 'task-1']],
    ['unknown_source', () => {}, ['push', 'origin', 'no-such-branch']],
    ['other_ref', s => { realGit(s.work, 'tag', 'v1'); }, ['push', 'origin', 'v1']],
    ['other_ref', () => {}, ['push', 'origin', 'HEAD:refs/tags/v1']],
    ['no_destination', () => {}, ['push', 'origin', 'HEAD~1']],
  ])('leaves %s to real git', (reason, prepare, argv) => {
    const s = stand();
    prepare(s);
    expect(resolve(s, ...argv)).toEqual({ unmanaged: reason });
  });

  it('keeps the literal refspec and options of a fetch', () => {
    const s = stand();
    expect(resolve(s, 'fetch', '-q', 'origin', 'turn-8')).toEqual({ request: { kind: 'fetch', cwd: s.work, remote: 'origin', refspec: 'turn-8', flags: ['--quiet'] } });
    expect(resolve(s, 'fetch', 'origin', 'refs/heads/a:refs/remotes/origin/a')).toEqual({ request: { kind: 'fetch', cwd: s.work, remote: 'origin', refspec: 'refs/heads/a:refs/remotes/origin/a', flags: [] } });
  });

  it('names the remote git itself takes for a fetch without one', () => {
    const s = stand();
    const configured = (remote: string) => ({ request: { kind: 'fetch_configured', cwd: s.work, remote, flags: [] } });
    expect(resolve(s, 'fetch')).toEqual(configured('origin'));
    realGit(s.work, 'remote', 'rename', 'origin', 'up');
    expect(resolve(s, 'fetch')).toEqual(configured('up'));
    expect(resolve(s, 'fetch', 'up')).toEqual(configured('up'));
    realGit(s.work, 'remote', 'add', 'other', s.url);
    expect(resolve(s, 'fetch')).toEqual({ unmanaged: 'ambiguous_fetch' });
    realGit(s.work, 'config', 'branch.task-1.remote', 'other');
    expect(resolve(s, 'fetch')).toEqual(configured('other'));
    realGit(s.work, 'checkout', '--quiet', '--detach');
    expect(resolve(s, 'fetch')).toEqual({ unmanaged: 'ambiguous_fetch' });
  });

  it.each<[string, (s: Stand) => void, string[]]>([
    ['url_remote', () => {}, ['fetch', 'nothing']],
    ['url_remote', s => { realGit(s.work, 'config', 'branch.task-1.remote', '.'); }, ['fetch']],
    ['multi_ref', s => { realGit(s.work, 'config', 'fetch.all', 'true'); }, ['fetch']],
  ])('leaves %s of a fetch by settings to real git', (reason, prepare, argv) => {
    const s = stand();
    prepare(s);
    expect(resolve(s, ...argv)).toEqual({ unmanaged: reason });
  });

  it('normalizes a fetch target without changing what it asks for', () => {
    expect(fetchTarget('turn-8')).toEqual({ kind: 'refspec', sourceRef: 'refs/heads/turn-8' });
    expect(fetchTarget('HEAD')).toEqual({ kind: 'refspec', sourceRef: 'HEAD' });
    expect(fetchTarget('refs/tags/v1')).toEqual({ kind: 'refspec', sourceRef: 'refs/tags/v1' });
    expect(fetchTarget('a:b')).toEqual({ kind: 'refspec', sourceRef: 'refs/heads/a', destinationRef: 'refs/heads/b' });
    expect(fetchTarget('refs/heads/a:refs/remotes/origin/a')).toEqual({ kind: 'refspec', sourceRef: 'refs/heads/a', destinationRef: 'refs/remotes/origin/a' });
    expect(fetchTarget('a'.repeat(40))).toEqual({ kind: 'commit', commitSha: 'a'.repeat(40) });
  });
});

describe('the bridge answers of the shim', () => {
  it('prints stdout and stderr exactly and ends with the exit code it is given', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [
      { type: 'stdout', data: Buffer.from('out\n').toString('base64') },
      { type: 'stderr', data: Buffer.from('err\n').toString('base64') },
      { type: 'exit', code: 7, signal: null },
    ]);
    expect(await inProcess(['push', 'origin', 'task-1'], s.work, env)).toEqual({ stdout: 'out\n', stderr: 'err\n', code: 7 });
    expect(calls(s, 'push')).toEqual([]);
  });

  it('ends with the code of a signal the node reports', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [{ type: 'exit', code: null, signal: 'SIGTERM' }]);
    expect((await inProcess(['push', 'origin', 'task-1'], s.work, env)).code).toBe(143);
    const unknown = await scriptedBridge(s, [{ type: 'exit', code: null, signal: 'SIGNOPE' }]);
    expect((await inProcess(['push', 'origin', 'task-1'], s.work, unknown)).code).toBe(128);
  });

  it.each([403, 404, 409, 503])('runs real git once when the bridge answers %i', async status => {
    const s = stand();
    const bridge = await refusingBridge(s, status);
    const ran = await inProcess(['push', 'origin', 'task-1'], s.work, bridge.env);
    expect(ran.code).toBe(0);
    expect(bridge.hits()).toBe(1);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
  });

  it('runs real git when the bridge cannot be reached', async () => {
    const s = stand();
    const ran = await inProcess(['push', 'origin', 'task-1'], s.work, baseEnv(s, { HH_BRIDGE: 'http://127.0.0.1:9/hook/secret' }));
    expect(ran.code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('runs real git when the bridge address cannot be read', async () => {
    const s = stand();
    const ran = await inProcess(['push', 'origin', 'task-1'], s.work, baseEnv(s, { HH_BRIDGE: 'not an address' }));
    expect(ran.code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('runs real git when the node says this operation is not managed', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [{ type: 'unmanaged', reason: 'adapter_off' }]);
    const ran = await inProcess(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it.each<[string, unknown[], 'end' | 'destroy']>([
    ['the stream ends without a result', [{ type: 'progress', text: 'waiting' }], 'end'],
    ['the connection breaks', [{ type: 'progress', text: 'waiting' }], 'destroy'],
    ['a frame cannot be read', ['not json\n'], 'end'],
    ['the node turns it down after output', [{ type: 'stdout', data: '' }, { type: 'unmanaged', reason: 'adapter_off' }], 'end'],
  ])('never repeats the push when %s', async (_name, frames, ending) => {
    const s = stand();
    const env = await scriptedBridge(s, frames, ending);
    const ran = await inProcess(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(128);
    expect(ran.stderr).toContain('result of this git command is not known');
    expect(calls(s, 'push')).toEqual([]);
  });

  it('ends quietly when nobody reads its output any more', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [{ type: 'stdout', data: Buffer.from('out\n').toString('base64') }, { type: 'exit', code: 0, signal: null }]);
    const child = spawn('/bin/bash', ['-c', `set -o pipefail; '${process.execPath}' '${SHIM}' push origin task-1 | (exec <&-; sleep 0.5)`], { cwd: s.work, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const status = await new Promise<number | null>(resolve => child.once('close', resolve));
    expect(stderr).toBe('');
    expect(status).toBe(141);
  });

  it('cleans and bounds the lines of progress it prints', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [
      { type: 'progress', text: `first\u001b[31m\nline ${'x'.repeat(500)}` },
      ...Array.from({ length: 60 }, () => ({ type: 'progress', text: 'again' })),
      { type: 'exit', code: 0, signal: null },
    ]);
    const lines = (await inProcess(['push', 'origin', 'task-1'], s.work, env)).stderr.trim().split('\n');
    expect(lines[0]).toMatch(/^hornhoof-git: first\[31m line x+$/);
    expect(lines[0]!.length).toBeLessThanOrEqual(320);
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it('prints only a marker it can read, on one line', () => {
    const operationId = '50000000-0000-4000-8000-000000000005';
    expect(shim.markerLine({ type: 'marker', operationId, generation: 2, state: 'outcome_unknown' })).toBe(`hornhoof-git: operation=${operationId} generation=2 state=outcome_unknown`);
    expect(shim.markerLine({ type: 'marker', operationId: 'x\nfatal: run this', generation: 2, state: 'satisfied' })).toBeNull();
    expect(shim.markerLine({ type: 'marker', operationId, generation: 2, state: 'satisfied\nrm -rf' })).toBeNull();
    expect(shim.markerLine({ type: 'marker', operationId, generation: 0, state: 'satisfied' })).toBeNull();
    expect(shim.markerLine({ type: 'marker', operationId, generation: 2.5, state: 'satisfied' })).toBeNull();
  });
});

describe('an ordinary push through the node', () => {
  it('pushes the pinned commit once and keeps the real output and exit code', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    const sha = head(s);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('');
    expect(ran.stderr).toContain(`${sha} -> task-1`);
    expect(ran.stderr).not.toContain('hornhoof-git');
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(sha);
    expect(calls(s, 'push').map(call => call.argv)).toEqual([['-C', s.work, 'push', 'origin', `${sha}:refs/heads/task-1`]]);
    expect(realGit(s.work, 'rev-parse', 'refs/remotes/origin/task-1')).toBe(sha);
  });

  it('registers a valid immutable intent bound to the current job', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    const [registered] = port.registered;
    expect(registered!.intent).toEqual({ kind: 'git_push', repositoryId: REPOSITORY, sourceSha: head(s), destinationRef: 'refs/heads/task-1' });
    expect(ExternalGitIntent.safeParse(registered!.intent).success).toBe(true);
    expect(ExternalConsumer.safeParse(registered!.consumer).success).toBe(true);
    expect(registered!.consumer).toEqual({ kind: 'agent_job', jobId: JOB, workspaceBinding: BINDING });
    expect(registered!.intentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(registered!.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('records what the node saw of its own child, not what the shim said', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    const [record] = port.recorded;
    expect(ExternalGitOutcome.safeParse(record!.outcome).success).toBe(true);
    expect(record).toMatchObject({ generation: 1, attemptId: '40000000-0000-4000-8000-000000000001', settled: true, outcome: { kind: 'child', exitCode: 0, signal: null, osCode: null } });
    expect(record!.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs a command after the push once, only after the push settled', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const bin = join(s.dir, 'bin'), log = join(s.dir, 'suffix.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nexec '${process.execPath}' '${SHIM}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    const child = spawn('/bin/sh', ['-c', `git push origin task-1 && echo suffix >> '${log}'`], { cwd: s.work, env: { ...env, PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv, stdio: 'ignore' });
    const ended = new Promise<number | null>(resolve => child.once('close', resolve));
    await eventually(() => port.recorded.length === 1);
    expect(existsSync(log)).toBe(false);
    port.release();
    expect(await ended).toBe(0);
    expect(readFileSync(log, 'utf8')).toBe('suffix\n');
    expect(calls(s, 'push')).toHaveLength(2);
  });

  it('sets up tracking after -u the way git does', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    const ran = await runShim(['push', '-u', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("branch 'task-1' set up to track 'origin/task-1'.");
    expect(realGit(s.work, 'config', 'branch.task-1.merge')).toBe('refs/heads/task-1');
    expect(realGit(s.work, 'status', '-sb')).toContain('task-1...origin/task-1');
  });

  it('passes -q on and prints nothing of its own', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    expect(await runShim(['push', '-q', 'origin', 'task-1'], s.work, env)).toEqual({ stdout: '', stderr: '', code: 0 });
  });

  it('never adds a force, another ref or another remote', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }];
    const { env } = await serve(s, port);
    const sha = head(s);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    port.release();
    await ran;
    const pushes = calls(s, 'push').map(call => call.argv);
    expect(pushes).toEqual([['-C', s.work, 'push', 'origin', `${sha}:refs/heads/task-1`], ['-C', s.work, 'push', 'origin', `${sha}:refs/heads/task-1`]]);
    expect(realGit(s.work, 'remote', 'get-url', 'origin')).toBe(s.url);
  });
});

describe('an ordinary fetch through the node', () => {
  it('runs the literal refspec and records the commit it saw', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    const ran = await runShim(['fetch', 'origin', 'main'], s.work, env);
    const remoteMain = remoteRef(s, 'refs/heads/main');
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain('main');
    expect(ran.stderr).toContain('FETCH_HEAD');
    expect(calls(s, 'fetch').map(call => call.argv)).toEqual([['-C', s.work, 'fetch', 'origin', 'main']]);
    expect(port.registered[0]!.intent).toEqual({ kind: 'git_fetch', repositoryId: REPOSITORY, target: { kind: 'refspec', sourceRef: 'refs/heads/main' } });
    expect(port.recorded[0]).toMatchObject({ settled: true, observedHead: remoteMain });
  });

  it('keeps the same refspec when the remote branch moves during the wait', async () => {
    const s = stand();
    planFor(s, { fetch: [{ do: 'say', stderr: 'fatal: unable to access: the requested URL returned error: 503\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }];
    const { env } = await serve(s, port);
    const ran = runShim(['fetch', 'origin', 'main'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    expect(port.recorded[0]!.observedHead).toBeUndefined();
    realGit(s.work, 'push', '--quiet', 'origin', 'task-1:main');
    const moved = remoteRef(s, 'refs/heads/main');
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(0);
    expect(ended.stderr).not.toContain('503');
    expect(calls(s, 'fetch').map(call => call.argv[call.argv.length - 1])).toEqual(['main', 'main']);
    expect(port.recorded[1]!.observedHead).toBe(moved);
    expect(port.registered).toHaveLength(1);
  });

  it('records the destination it wrote for a fetch with one', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    const ran = await runShim(['fetch', 'origin', 'refs/heads/main:refs/remotes/mine/main'], s.work, env);
    expect(ran.code).toBe(0);
    expect(port.registered[0]!.intent).toEqual({ kind: 'git_fetch', repositoryId: REPOSITORY, target: { kind: 'refspec', sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/mine/main' } });
    expect(port.recorded[0]!.observedHead).toBe(remoteRef(s, 'refs/heads/main'));
  });
});
