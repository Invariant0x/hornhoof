import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ExternalConsumer, ExternalGitIntent, ExternalGitOutcome } from '@hornhoof/protocol';
import { GitAdapter, fetchTarget, parseGitMarker, type GitGrant, type GitJob, type GitOperationPort, type GitRecord, type GitRecordReply, type GitRegistration } from '../src/external-git.js';

const SHIM = fileURLToPath(new URL('../hh-git.cjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fakes/fake-git.mjs', import.meta.url));
const KEY = '10000000-0000-4000-8000-000000000001';
const JOB = '20000000-0000-4000-8000-000000000002';
const REPOSITORY = '30000000-0000-4000-8000-000000000003';
const BINDING = 'b'.repeat(64);
const OPERATION_LINE = /^hornhoof-git: operation=[0-9a-f-]{36} generation=\d+ state=[a-z_]+$/m;

type Env = Record<string, string | undefined>;
type Route = { kind: string; reason?: string; remote?: string; refspec?: string; flags?: string[]; setUpstream?: boolean; cwd?: string };
type Resolved = { unmanaged?: string; request?: Record<string, unknown> };
type Shim = {
  UNMANAGED: Record<string, string>;
  routeGit(argv: string[], env: Env, cwd: string): Route;
  resolveRequest(route: Route, env: Env): Resolved;
  markerLine(frame: unknown): string | null;
};
const shim = createRequire(import.meta.url)(SHIM) as Shim;

type Stand = { dir: string; work: string; remote: string; url: string; bin: string; token: string };
type Ran = { stdout: string; stderr: string; code: number | null };
const realGit = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function stand(): Stand {
  const dir = mkdtempSync(join(tmpdir(), 'hh-git-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'remote.git'), work = join(dir, 'work'), url = `file://${remote}`, bin = join(dir, 'git');
  realGit(dir, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  realGit(dir, 'clone', '--quiet', url, work);
  realGit(work, 'checkout', '--quiet', '-B', 'main');
  realGit(work, 'config', 'user.name', 'Test');
  realGit(work, 'config', 'user.email', 'test@example.test');
  commit(work, 'first');
  realGit(work, 'push', '--quiet', 'origin', 'main');
  realGit(work, 'checkout', '--quiet', '-b', 'task-1');
  commit(work, 'second');
  writeFileSync(bin, `#!/bin/sh\nHH_FAKE_GIT_DIR='${dir}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(bin, 0o755);
  return { dir, work, remote, url, bin, token: 'first-secret-token' };
}

function commit(work: string, name: string): string {
  writeFileSync(join(work, `${name}.txt`), name);
  realGit(work, 'add', '.');
  realGit(work, 'commit', '--quiet', '-m', name);
  return realGit(work, 'rev-parse', 'HEAD');
}

const head = (s: Stand) => realGit(s.work, 'rev-parse', 'HEAD');
const remoteRef = (s: Stand, ref: string) => spawnSync('/usr/bin/git', ['rev-parse', '--verify', '--quiet', ref], { cwd: s.remote, encoding: 'utf8' }).stdout.trim();
const planFor = (s: Stand, plan: Record<string, unknown[]>) => writeFileSync(join(s.dir, 'plan.json'), JSON.stringify(plan));
const calls = (s: Stand, command: string): Array<{ argv: string[]; token: string | null; nested: string | null }> => {
  const file = join(s.dir, 'log.ndjson');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { command: string; argv: string[]; token: string | null; nested: string | null }).filter(call => call.command === command);
};

function runShim(args: string[], cwd: string, env: Env): Promise<Ran> & { partial: () => Ran; signal: (name: NodeJS.Signals) => void } {
  const child = spawn(process.execPath, [SHIM, ...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<Ran>(resolve => child.once('close', code => resolve({ stdout, stderr, code })));
  return Object.assign(done, { partial: () => ({ stdout, stderr, code: null }), signal: (name: NodeJS.Signals) => { child.kill(name); } });
}

const jobOf = (s: Stand): GitJob => ({ jobId: JOB, repositoryId: REPOSITORY, workspaceBinding: BINDING, url: s.url, token: () => s.token, user: null, home: s.dir });
const baseEnv = (s: Stand, extra: Env = {}): Env => ({ PATH: process.env.PATH, HOME: s.dir, HH_REAL_GIT: s.bin, ...extra });

class FakePort implements GitOperationPort {
  registered: Parameters<GitOperationPort['register']>[0][] = [];
  recorded: GitRecord[] = [];
  cancelled: Array<{ operationId: string; generation: number }> = [];
  replies: GitRecordReply[] = [];
  private generation = 1;
  private grant: ((value: GitGrant) => void) | null = null;
  registration: Partial<GitRegistration> = {};
  registerFails: Error | null = null;
  recordFails: Error | null = null;
  readyFails: Error | null = null;
  beforeRegister: () => void = () => {};

  async register(input: Parameters<GitOperationPort['register']>[0]): Promise<GitRegistration> {
    if (this.registerFails) throw this.registerFails;
    this.beforeRegister();
    this.registered.push(input);
    return { operationId: input.operationId, generation: 1, attemptId: '40000000-0000-4000-8000-000000000001', disposition: 'execute', ...this.registration } as GitRegistration;
  }

  async record(input: GitRecord): Promise<GitRecordReply> {
    if (this.recordFails) throw this.recordFails;
    this.recorded.push(input);
    return this.replies.shift() ?? { accepted: true, state: 'satisfied' };
  }

  ready(_operationId: string, signal: AbortSignal): Promise<GitGrant> {
    if (this.readyFails) return Promise.reject(this.readyFails);
    return new Promise((resolve, reject) => {
      this.grant = resolve;
      if (signal.aborted) reject(new Error('stopped'));
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
  }

  release(grant: Record<string, unknown> = {}): void {
    this.generation += 1;
    this.grant?.({ generation: this.generation, attemptId: `40000000-0000-4000-8000-00000000000${this.generation}`, disposition: 'execute', ...grant } as GitGrant);
  }

  async cancel(input: { operationId: string; generation: number }): Promise<void> {
    this.cancelled.push(input);
  }
}

type Served = { adapter: GitAdapter; env: Env; server: Server; hits: () => number };

async function serve(s: Stand, port: GitOperationPort | null, bound = true, options: Partial<ConstructorParameters<typeof GitAdapter>[0]> = {}): Promise<Served> {
  const adapter = new GitAdapter({ port, git: s.bin, ...options });
  if (bound) adapter.bind(KEY, jobOf(s));
  let hits = 0;
  const server = createServer((req, res: ServerResponse) => {
    hits += 1;
    const parts: Buffer[] = [];
    req.on('data', part => parts.push(part as Buffer));
    req.on('end', () => {
      const stop = new AbortController();
      res.once('close', () => stop.abort());
      void adapter.serve(KEY, Buffer.concat(parts), stop.signal, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => { adapter.stop(); server.closeAllConnections(); server.close(); });
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret`;
  return { adapter, server, env: baseEnv(s, { HH_BRIDGE: hook }), hits: () => hits };
}

async function refusingBridge(s: Stand, status: number): Promise<{ env: Env; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; req.resume(); res.writeHead(status); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  return { env: baseEnv(s, { HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret` }), hits: () => hits };
}

/* A bridge that writes the frames a test names, then ends or breaks the connection. */
async function scriptedBridge(s: Stand, frames: unknown[], ending: 'end' | 'destroy' = 'end'): Promise<Env> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    for (const frame of frames) res.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`);
    if (ending === 'end') res.end();
    else setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  return baseEnv(s, { HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret` });
}

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

  it('gives a missing git binary the shell code for it', async () => {
    const s = stand();
    const ran = await runShim(['status'], s.work, baseEnv(s, { HH_REAL_GIT: join(s.dir, 'no-such-git') }));
    expect(ran.code).toBe(127);
    expect(ran.stderr).toContain('no-such-git');
  });

  it('ends with the code of a signal that stopped real git', async () => {
    const s = stand();
    planFor(s, { status: [{ do: 'hang' }] });
    const ran = runShim(['status'], s.work, baseEnv(s));
    await vi.waitFor(() => { expect(calls(s, 'status')).toHaveLength(1); }, { timeout: 5000 });
    await vi.waitFor(() => { expect(ran.partial().stderr).toContain('still working'); }, { timeout: 5000 });
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
    ['dynamic_refspec', ['fetch']],
    ['dynamic_refspec', ['fetch', 'origin']],
    ['dynamic_refspec', ['fetch', 'origin', 'refs/heads/*:refs/remotes/origin/*']],
    ['dynamic_refspec', ['push', 'origin', 'refs/heads/*:refs/heads/*']],
    ['dynamic_refspec', ['fetch', 'origin', ':refs/heads/x']],
  ])('names %s for %j', (reason, argv, given) => {
    expect(shim.routeGit(argv, given ?? env, '/work')).toEqual({ kind: 'unmanaged', reason });
  });

  it('lists every reason it can give, in plain words', () => {
    for (const reason of ['no_bridge', 'nested', 'global_option', 'custom_environment', 'force', 'delete', 'multi_ref', 'dry_run', 'custom_transport', 'option', 'dynamic_refspec', 'url_remote', 'multi_target', 'configured_refspec', 'no_current_branch', 'no_upstream', 'ambiguous_default', 'unknown_source', 'other_ref', 'no_destination']) {
      expect(shim.UNMANAGED[reason]?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it('reads the options it keeps and the folder of -C', () => {
    expect(shim.routeGit(['-C', 'sub', 'push', '-u', '-q', 'origin', 'task-1'], env, '/work')).toEqual({ kind: 'push', cwd: '/work/sub', remote: 'origin', refspec: 'task-1', flags: ['--quiet'], setUpstream: true });
    expect(shim.routeGit(['push', '--verbose', '--no-progress', '--porcelain', '--no-verify'], env, '/work')).toEqual({ kind: 'push', cwd: '/work', remote: null, refspec: null, flags: ['--verbose', '--no-progress', '--porcelain', '--no-verify'], setUpstream: false });
    expect(shim.routeGit(['fetch', '-q', '--progress', '-n', 'origin', 'turn-8'], env, '/work')).toEqual({ kind: 'fetch', cwd: '/work', remote: 'origin', refspec: 'turn-8', flags: ['--quiet', '--progress', '--no-tags'] });
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
    expect(await runShim(['push', 'origin', 'task-1'], s.work, env)).toEqual({ stdout: 'out\n', stderr: 'err\n', code: 7 });
    expect(calls(s, 'push')).toEqual([]);
  });

  it('ends with the code of a signal the node reports', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [{ type: 'exit', code: null, signal: 'SIGTERM' }]);
    expect((await runShim(['push', 'origin', 'task-1'], s.work, env)).code).toBe(143);
    const unknown = await scriptedBridge(s, [{ type: 'exit', code: null, signal: 'SIGNOPE' }]);
    expect((await runShim(['push', 'origin', 'task-1'], s.work, unknown)).code).toBe(128);
  });

  it.each([403, 404, 409, 503])('runs real git once when the bridge answers %i', async status => {
    const s = stand();
    const bridge = await refusingBridge(s, status);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, bridge.env);
    expect(ran.code).toBe(0);
    expect(bridge.hits()).toBe(1);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
  });

  it('runs real git when the bridge cannot be reached', async () => {
    const s = stand();
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, baseEnv(s, { HH_BRIDGE: 'http://127.0.0.1:9/hook/secret' }));
    expect(ran.code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('runs real git when the bridge address cannot be read', async () => {
    const s = stand();
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, baseEnv(s, { HH_BRIDGE: 'not an address' }));
    expect(ran.code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('runs real git when the node says this operation is not managed', async () => {
    const s = stand();
    const env = await scriptedBridge(s, [{ type: 'unmanaged', reason: 'adapter_off' }]);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
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
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
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
    const lines = (await runShim(['push', 'origin', 'task-1'], s.work, env)).stderr.trim().split('\n');
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
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); }, { timeout: 5000 });
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
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); }, { timeout: 5000 });
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
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); }, { timeout: 5000 });
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

describe('a refused push while the service recovers', () => {
  async function refusedOnce(s: Stand, extra: GitRecordReply[] = []) {
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: '2026-11-06T08:00:00.000Z' }, ...extra];
    const served = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, served.env);
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); expect(ran.partial().stderr).toContain('2026-11-06T08:00:00.000Z'); }, { timeout: 5000 });
    return { port, ran, ...served };
  }

  it('keeps the command waiting without showing the raw refusal', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    const shown = ran.partial().stderr;
    expect(shown).not.toContain('commit_refs_rules');
    expect(shown).not.toContain('remote rejected');
    expect(shown).toContain('nothing to investigate');
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { kind: 'child', exitCode: 1, stderr: expect.stringContaining('commit_refs_rules') as string } });
    port.release();
    await ran;
  });

  it('finishes with the output of the attempt that worked', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(0);
    expect(ended.stderr).not.toContain('commit_refs_rules');
    expect(ended.stderr).toContain('-> task-1');
    expect(ended.stderr).toMatch(OPERATION_LINE);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
    expect(port.registered).toHaveLength(1);
    expect(port.recorded.map(record => record.generation)).toEqual([1, 2]);
  });

  it('publishes the pinned commit when the local branch moved during the wait', async () => {
    const s = stand();
    const pinned = head(s);
    const { port, ran } = await refusedOnce(s);
    const later = commit(s.work, 'third');
    port.release();
    expect((await ran).code).toBe(0);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(pinned);
    expect(later).not.toBe(pinned);
    expect(head(s)).toBe(later);
  });

  it('looks the credential up again before each attempt', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    s.token = 'second-secret-token';
    port.release();
    await ran;
    expect(calls(s, 'push').map(call => call.token)).toEqual(['first-secret-token', 'second-secret-token']);
    expect(calls(s, 'push').every(call => call.nested === '1')).toBe(true);
  });

  it('uses the credential of a job bound again during the wait', async () => {
    const s = stand();
    const { port, ran, adapter } = await refusedOnce(s);
    adapter.bind(KEY, { ...jobOf(s), token: () => 'renewed-secret-token' });
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push').map(call => call.token)).toEqual(['first-secret-token', 'renewed-secret-token']);
    expect(port.cancelled).toEqual([]);
  });

  it('stops without an attempt when the remote changed during the wait', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    realGit(s.work, 'remote', 'set-url', 'origin', `${s.url}.other`);
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(128);
    expect(ended.stderr).toContain('the remote changed');
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toHaveLength(1);
  });

  it('stops without an attempt when the job ended during the wait', async () => {
    const s = stand();
    const { port, ran, adapter } = await refusedOnce(s);
    adapter.unbind(KEY);
    const ended = await ran;
    expect(ended.code).toBe(128);
    expect(ended.stderr).toContain('the turn ended');
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toEqual([{ operationId: port.registered[0]!.operationId, generation: 1 }]);
  });

  it('stops without an attempt when another job took the agent during the wait', async () => {
    const s = stand();
    const { port, ran, adapter } = await refusedOnce(s);
    adapter.bind(KEY, { ...jobOf(s), jobId: '20000000-0000-4000-8000-000000000009' });
    const ended = await ran;
    expect(ended.code).toBe(128);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toHaveLength(1);
  });

  it('cancels the wait when the caller goes away and never pushes again', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    ran.signal('SIGTERM');
    await ran;
    await vi.waitFor(() => { expect(port.cancelled).toHaveLength(1); }, { timeout: 5000 });
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('says so when the server can no longer answer during a wait', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.readyFails = new Error('no link');
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(128);
    expect(ran.stderr).toContain('stopped waiting');
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toHaveLength(1);
  });

  it('shows what Hornhoof ended it with when no attempt follows', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    port.release({ disposition: 'terminal', state: 'failed_permanent' });
    const ended = await ran;
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain('commit_refs_rules');
    expect(ended.stderr).toMatch(OPERATION_LINE);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('keeps waiting through a grant to wait', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    port.release({ disposition: 'wait', nextAttemptAt: '2026-11-06T09:00:00.000Z' });
    await vi.waitFor(() => { expect(ran.partial().stderr).toContain('2026-11-06T09:00:00.000Z'); }, { timeout: 5000 });
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(2);
  });
});

describe('a push with an unknown outcome', () => {
  it('reads the exact ref and does not push again when the remote already has the commit', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'accept_then_hang' }] });
    const port = new FakePort();
    const { env } = await serve(s, port);
    const sha = head(s);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain('hung up');
    expect(ran.stderr).toContain('already has');
    expect(ran.stderr).toMatch(OPERATION_LINE);
    expect(port.recorded[0]).toMatchObject({ observedHead: sha, outcome: { exitCode: 128 } });
    expect(calls(s, 'push')).toHaveLength(1);
    expect(calls(s, 'ls-remote').at(-1)!.argv).toEqual(['-C', s.work, 'ls-remote', 'origin', 'refs/heads/task-1']);
  });

  it('does not take another ref ending the same way for the target', async () => {
    const s = stand();
    realGit(s.work, 'push', '--quiet', 'origin', 'main:refs/tags/refs/heads/task-1');
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(port.recorded[0]!.observedHead).toBeNull();
  });

  it('says an absent target is absent and keeps the author error when nothing explains it', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'say', stderr: 'error: something unexpected\n', exit: 1 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(port.recorded[0]!.observedHead).toBeNull();
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('error: something unexpected');
    expect(ran.stderr).toMatch(/state=outcome_unknown$/m);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('keeps waiting while the target cannot be read, then settles without a second push', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'accept_then_hang' }], 'ls-remote': [{ do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const sha = head(s);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); expect(ran.partial().stderr).toContain('not known yet'); }, { timeout: 5000 });
    expect(port.recorded[0]!.observedHead).toBeUndefined();
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(0);
    expect(port.recorded[1]).toMatchObject({ generation: 2, observedHead: sha, outcome: { exitCode: 128 } });
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('pushes again only after reading that the target still differs', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }], 'ls-remote': [{ do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); }, { timeout: 5000 });
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(2);
    expect(calls(s, 'ls-remote').length).toBeGreaterThanOrEqual(2);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
  });

  it('keeps the first answer when the node cannot record the result', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'say', stderr: 'error: something unexpected\n', exit: 1 }] });
    const port = new FakePort();
    port.recordFails = new Error('no link');
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('error: something unexpected');
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('gives the result of a stale generation back without another attempt', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: false, state: 'deferred', nextAttemptAt: null }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('commit_refs_rules');
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('leaves a settled unknown result to the author with its real exit code', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'say', stderr: 'error: strange\n', stdout: 'report\n', exit: 3 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    realGit(s.work, 'push', '--quiet', 'origin', 'main:refs/heads/task-1');
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(port.recorded[0]!.observedHead).toBe(remoteRef(s, 'refs/heads/task-1'));
    expect(ran).toMatchObject({ code: 3, stdout: 'report\n' });
    expect(ran.stderr).toContain('error: strange');
  });
});

describe('a permanent refusal', () => {
  it('reaches the author as real git said it, once', async () => {
    const s = stand();
    realGit(s.work, 'push', '--quiet', 'origin', 'task-1');
    const other = mkdtempSync(join(s.dir, 'other-'));
    realGit(other, 'clone', '--quiet', '--branch', 'task-1', s.url, '.');
    realGit(other, 'config', 'user.name', 'Test');
    realGit(other, 'config', 'user.email', 'test@example.test');
    commit(other, 'theirs');
    realGit(other, 'push', '--quiet', 'origin', 'task-1');
    realGit(s.work, 'fetch', '--quiet', 'origin', 'task-1');
    commit(s.work, 'mine');
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('rejected');
    expect(ran.stderr).toContain('non-fast-forward');
    expect(ran.stderr).toMatch(/state=failed_permanent$/m);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.recorded[0]).toMatchObject({ outcome: { exitCode: 1 } });
  });
});

describe('what stays unmanaged at the node', () => {
  const pushed = (s: Stand) => ({ kind: 'push', cwd: s.work, remote: 'origin', sourceSha: head(s), destinationRef: 'refs/heads/task-1', upstreamBranch: null, flags: [] });

  async function answer(served: Served, body: unknown): Promise<unknown[]> {
    const hook = served.env.HH_BRIDGE!.replace('/hook/', '/git/');
    const response = await fetch(hook, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line) as unknown);
  }

  it('answers adapter_off while the wire is off and real git still works', async () => {
    const s = stand();
    const served = await serve(s, null);
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'adapter_off' }]);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, served.env);
    expect(ran.code).toBe(0);
    expect(calls(s, 'push').map(call => call.nested)).toEqual([null]);
  });

  it('answers no_current_job between turns', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port, false);
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'no_current_job' }]);
    expect(port.registered).toEqual([]);
  });

  it('never runs git of an agent repository as root', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port, false);
    served.adapter.bind(KEY, { ...jobOf(s), user: { uid: 0, gid: 0 } });
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'no_agent_user' }]);
    expect(calls(s, 'remote')).toEqual([]);
    expect(port.registered).toEqual([]);
  });

  it('takes a user it cannot become as a remote it cannot read', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port, false);
    const other = (process.getuid?.() ?? 1000) + 1;
    served.adapter.bind(KEY, { ...jobOf(s), user: { uid: other, gid: other } });
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'foreign_endpoint' }]);
    expect(port.registered).toEqual([]);
  });

  it('answers foreign_endpoint for a remote outside the job repository', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    realGit(s.work, 'remote', 'add', 'other', `${s.url}.other`);
    expect(await answer(served, { ...pushed(s), remote: 'other' })).toEqual([{ type: 'unmanaged', reason: 'foreign_endpoint' }]);
    expect(port.registered).toEqual([]);
  });

  it('answers foreign_endpoint for a remote it cannot read', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    expect(await answer(served, { ...pushed(s), remote: 'nothing' })).toEqual([{ type: 'unmanaged', reason: 'foreign_endpoint' }]);
  });

  it('answers port_unavailable when the server cannot take the operation', async () => {
    const s = stand();
    const port = new FakePort();
    port.registerFails = new Error('unsupported producer');
    const served = await serve(s, port);
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'port_unavailable' }]);
    expect(calls(s, 'push')).toEqual([]);
  });

  it.each<[string, (s: Stand) => unknown]>([
    ['text', () => 'not json'],
    ['a command line', s => ({ kind: 'push', cwd: s.work, argv: ['push', '--force'] })],
    ['extra fields', s => ({ ...pushed(s), env: { HH_GIT_PASSWORD: 'stolen' } })],
    ['a force flag', s => ({ ...pushed(s), flags: ['--force'] })],
    ['a source that is no commit', s => ({ ...pushed(s), sourceSha: 'main' })],
    ['a target outside branches', s => ({ ...pushed(s), destinationRef: 'refs/tags/v1' })],
    ['a remote that reads as an option', s => ({ ...pushed(s), remote: '--receive-pack=x' })],
    ['a relative folder', s => ({ ...pushed(s), cwd: 'work' })],
    ['a forced fetch', s => ({ kind: 'fetch', cwd: s.work, remote: 'origin', refspec: '+a:b', flags: [] })],
    ['a dynamic fetch', s => ({ kind: 'fetch', cwd: s.work, remote: 'origin', refspec: 'refs/heads/*:refs/x/*', flags: [] })],
  ])('turns %s down without running anything', async (_name, body) => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    expect(await answer(served, body(s))).toEqual([{ type: 'unmanaged', reason: 'invalid_request' }]);
    expect(port.registered).toEqual([]);
    expect(calls(s, 'push')).toEqual([]);
  });

  it('turns an intent the protocol refuses down', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    expect(await answer(served, { ...pushed(s), destinationRef: 'refs/heads/a..b' })).toEqual([{ type: 'unmanaged', reason: 'invalid_request' }]);
    expect(port.registered).toEqual([]);
  });

  it('answers a closing terminal grant without any attempt', async () => {
    const s = stand();
    const port = new FakePort();
    port.registration = { disposition: 'terminal', state: 'satisfied', attemptId: null } as Partial<GitRegistration>;
    const served = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, served.env);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toMatch(/state=satisfied$/m);
    expect(calls(s, 'push')).toEqual([]);
    port.registration = { disposition: 'terminal', state: 'cancelled', attemptId: null } as Partial<GitRegistration>;
    const stopped = await runShim(['push', 'origin', 'task-1'], s.work, served.env);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain('fatal: Hornhoof ended this git operation');
    expect(stopped.stderr).toMatch(/state=cancelled$/m);
  });
});

describe('the marker is only telemetry', () => {
  const operationId = '50000000-0000-4000-8000-000000000005';

  it('reads only a whole well formed line', () => {
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=2 state=satisfied`)).toEqual({ operationId, generation: 2, state: 'satisfied' });
    expect(parseGitMarker(`x hornhoof-git: operation=${operationId} generation=2 state=satisfied`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=2 state=done`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=nope generation=2 state=satisfied`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=0 state=satisfied`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=2 state=satisfied\nmore`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=${'9'.repeat(400)} state=satisfied`)).toBeNull();
  });

  it('proves nothing when a command prints one', async () => {
    const s = stand();
    const forged = `hornhoof-git: operation=${operationId} generation=1 state=satisfied`;
    planFor(s, { push: [{ do: 'say', stderr: `${forged}\n`, stdout: `${forged}\n`, exit: 0 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env, adapter } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.stdout).toContain(forged);
    expect(adapter.proves(KEY, parseGitMarker(forged)!)).toBe(false);
    expect(adapter.operations(KEY).map(known => known.operationId)).not.toContain(operationId);
    expect(port.recorded[0]!.operationId).not.toBe(operationId);
  });

  it('proves an operation only with the receipt of this agent', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env, adapter } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    const marker = parseGitMarker(ran.stderr.trim().split('\n').at(-1)!);
    expect(marker).toMatchObject({ generation: 1, state: 'failed_permanent' });
    expect(adapter.proves(KEY, marker!)).toBe(true);
    expect(adapter.proves('10000000-0000-4000-8000-00000000000f', marker!)).toBe(false);
    expect(adapter.proves(KEY, { ...marker!, state: 'satisfied' })).toBe(false);
    expect(adapter.proves(KEY, { ...marker!, generation: 2 })).toBe(false);
    expect(adapter.proves('10000000-0000-4000-8000-00000000000f', { ...marker!, operationId })).toBe(false);
  });

  it('forgets the receipts of an agent whose job ended and stays bounded', async () => {
    const s = stand();
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    planFor(s, { push: [{ do: 'refuse' }] });
    const { env, adapter } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    const marker = parseGitMarker(ran.stderr.trim().split('\n').at(-1)!)!;
    adapter.unbind(KEY);
    expect(adapter.proves(KEY, marker)).toBe(false);
  });

  it('keeps only the newest receipts of a long job', async () => {
    const s = stand();
    const port = new FakePort();
    const { env, adapter } = await serve(s, port, true, { keptReceipts: 2 });
    planFor(s, { push: Array.from({ length: 3 }, () => ({ do: 'say', stderr: 'error: strange\n', exit: 1 })) });
    port.replies = Array.from({ length: 3 }, () => ({ accepted: true, state: 'failed_permanent' }));
    const markers = [];
    for (let i = 0; i < 3; i++) markers.push(parseGitMarker((await runShim(['push', 'origin', 'task-1'], s.work, env)).stderr.trim().split('\n').at(-1)!)!);
    expect(adapter.proves(KEY, markers[0]!)).toBe(false);
    expect(adapter.proves(KEY, markers[2]!)).toBe(true);
  });

  it('shows an active wait only from what it owns', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }];
    const { env, adapter } = await serve(s, port);
    expect(adapter.operations(KEY)).toEqual([]);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); }, { timeout: 5000 });
    await vi.waitFor(() => { expect(adapter.operations(KEY)).toEqual([{ operationId: port.registered[0]!.operationId, state: 'waiting' }]); }, { timeout: 5000 });
    port.release();
    await ran;
    expect(adapter.operations(KEY)).toEqual([]);
  });
});

describe('the child the node owns', () => {
  it('hides the credential and bounds what it reports', async () => {
    const s = stand();
    const long = `${'e'.repeat(9000)} first-secret-token\nfatal: https://name:first-secret-token@example.test/x\n`;
    planFor(s, { push: [{ do: 'say', stderr: long, exit: 1 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    const outcome = port.recorded[0]!.outcome as Extract<ExternalGitOutcome, { kind: 'child' }>;
    expect(ExternalGitOutcome.safeParse(outcome).success).toBe(true);
    expect(outcome.stderr).not.toContain('first-secret-token');
    expect(outcome.stderr.length).toBeLessThanOrEqual(8192);
    expect(outcome.stderrTruncated).toBe(true);
    expect(outcome.stderr).toContain('[hidden]');
  });

  it('holds output within its bound while keeping the end', async () => {
    const s = stand();
    const huge = `${'x'.repeat(2 * 1024 * 1024)}\nthe end\n`;
    planFor(s, { push: [{ do: 'say', stderr: huge, exit: 1 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port, true, { heldBytes: 64 * 1024 });
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.stderr).toContain('the end');
    expect(ran.stderr).toContain('output shortened');
    expect(ran.stderr.length).toBeLessThan(256 * 1024);
  });

  it('stops its child when the caller goes away and reports it settled', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'hang' }] });
    const port = new FakePort();
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await vi.waitFor(() => { expect(calls(s, 'push')).toHaveLength(1); }, { timeout: 5000 });
    ran.signal('SIGTERM');
    await ran;
    await vi.waitFor(() => { expect(port.recorded).toHaveLength(1); }, { timeout: 10_000 });
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { kind: 'child' } });
    await vi.waitFor(() => { expect(port.cancelled).toHaveLength(1); }, { timeout: 5000 });
  });

  it('reports a child it could not start with its operating system code', async () => {
    const s = stand();
    const port = new FakePort();
    port.beforeRegister = () => rmSync(s.bin);
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(127);
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { kind: 'child', exitCode: null, signal: null, osCode: 'ENOENT' } });
  });

  it('does not wait for a stray process that keeps the pipes open', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'leave_process' }] });
    const port = new FakePort();
    const { env } = await serve(s, port, true, { exitGraceMs: 50 });
    const started = Date.now();
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { exitCode: 0 } });
  });

  it('reads the target again only for a push', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    await runShim(['fetch', 'origin', 'main'], s.work, env);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(calls(s, 'ls-remote')).toEqual([]);
  });
});
