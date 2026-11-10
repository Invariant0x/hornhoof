import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, vi } from 'vitest';
import { GitAdapter, type GitGrant, type GitJob, type GitOperationPort, type GitReconciliation, type GitRecord, type GitRecordReply, type GitRegistration } from '../src/external-git.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { listenIn } from '../../../test-support/ports.mjs';

/* What the tests of hh-git and of the git adapter of the node share: a real repository with a bare remote, behind a stand-in
   for real git that refuses when a test says so (fakes/fake-git.mjs), the shim run as a program or in this process, and a fake
   server port and bridge. */

export const SHIM = fileURLToPath(new URL('../hh-git.cjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fakes/fake-git.mjs', import.meta.url));
export const KEY = '10000000-0000-4000-8000-000000000001';
export const JOB = '20000000-0000-4000-8000-000000000002';
export const REPOSITORY = '30000000-0000-4000-8000-000000000003';
export const BINDING = 'b'.repeat(64);
export const OPERATION_LINE = /^hornhoof-git: operation=[0-9a-f-]{36} generation=\d+ state=[a-z_]+$/m;

export type Env = Record<string, string | undefined>;
type Route = { kind: string; reason?: string; remote?: string; refspec?: string; flags?: string[]; setUpstream?: boolean; cwd?: string };
type Resolved = { unmanaged?: string; request?: Record<string, unknown> };
type Written = { write(chunk: Buffer | string): unknown };
type Shim = {
  UNMANAGED: Record<string, string>;
  main(argv: string[], env: Env, cwd: string, io: { stdout: Written; stderr: Written; stdio: 'ignore' | 'inherit' }): Promise<number>;
  routeGit(argv: string[], env: Env, cwd: string): Route;
  resolveRequest(route: Route, env: Env): Resolved;
  markerLine(frame: unknown): string | null;
};
export const shim = createRequire(import.meta.url)(SHIM) as Shim;

export type Stand = { dir: string; work: string; remote: string; url: string; bin: string; token: string };
type Ran = { stdout: string; stderr: string; code: number | null };
export const realGit = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function stand(): Stand {
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

export function commit(work: string, name: string): string {
  writeFileSync(join(work, `${name}.txt`), name);
  realGit(work, 'add', '.');
  realGit(work, 'commit', '--quiet', '-m', name);
  return realGit(work, 'rev-parse', 'HEAD');
}

export const head = (s: Stand) => realGit(s.work, 'rev-parse', 'HEAD');
export const remoteRef = (s: Stand, ref: string) => spawnSync('/usr/bin/git', ['rev-parse', '--verify', '--quiet', ref], { cwd: s.remote, encoding: 'utf8' }).stdout.trim();
export const planFor = (s: Stand, plan: Record<string, unknown[]>) => writeFileSync(join(s.dir, 'plan.json'), JSON.stringify(plan));
/* A git that hangs says so once it is in place, with any stop it ignores. */
export const hanging = (s: Stand) => existsSync(join(s.dir, 'hanging'));
export const calls = (s: Stand, command: string): Array<{ argv: string[]; token: string | null; nested: string | null }> => {
  const file = join(s.dir, 'log.ndjson');
  if (!existsSync(file)) return [];
  /* Whole lines only: the fake git may be writing the next one. */
  return readFileSync(file, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line) as { command: string; argv: string[]; token: string | null; nested: string | null }).filter(call => call.command === command);
};

export function runShim(args: string[], cwd: string, env: Env): Promise<Ran> & { partial: () => Ran; signal: (name: NodeJS.Signals) => void } {
  const child = spawn(process.execPath, [SHIM, ...args], { cwd, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const done = new Promise<Ran>(resolve => child.once('close', code => resolve({ stdout, stderr, code })));
  return Object.assign(done, { partial: () => ({ stdout, stderr, code: null }), signal: (name: NodeJS.Signals) => { child.kill(name); } });
}

export const jobOf = (s: Stand): GitJob => ({ jobId: JOB, repositoryId: REPOSITORY, workspaceBinding: BINDING, url: s.url, token: () => s.token, user: null, home: s.dir });
/* The same program as runShim, inside the test's own process. Real git is told its folder with -C. */
export async function inProcess(args: string[], cwd: string, env: Env): Promise<Ran> {
  let stdout = '', stderr = '';
  const code = await shim.main(['-C', cwd, ...args], env, cwd, { stdout: { write: chunk => { stdout += String(chunk); } }, stderr: { write: chunk => { stderr += String(chunk); } }, stdio: 'ignore' });
  return { stdout, stderr, code };
}

export const baseEnv = (s: Stand, extra: Env = {}): Env => ({ PATH: process.env.PATH, HOME: s.dir, HH_REAL_GIT: s.bin, ...extra });

export class FakePort implements GitOperationPort {
  registered: Parameters<GitOperationPort['register']>[0][] = [];
  recorded: GitRecord[] = [];
  reconciled: GitReconciliation[] = [];
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

  private async answer<T>(seen: T[], input: T): Promise<GitRecordReply> {
    if (this.recordFails) throw this.recordFails;
    seen.push(input);
    return this.replies.shift() ?? { accepted: true, state: 'satisfied' };
  }

  record(input: GitRecord): Promise<GitRecordReply> {
    return this.answer(this.recorded, input);
  }

  reconcile(input: GitReconciliation): Promise<GitRecordReply> {
    return this.answer(this.reconciled, input);
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

/* The longest delay a timer takes: the node's graces for a child never run out in a test that does not drive them. */
const NEVER = 2_147_483_647;

/* The node's graces for a child, on a clock the test moves. */
export function graceClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => { vi.useRealTimers(); });
}

/* The signals the node sends to the process groups of its children, which still reach them. */
export function killed(): () => string[] {
  const kill = vi.spyOn(process, 'kill');
  onTestFinished(() => { kill.mockRestore(); });
  return () => kill.mock.calls.filter(([pid]) => Number(pid) < 0).map(([, signal]) => String(signal));
}

export async function serve(s: Stand, port: GitOperationPort | null, bound = true, options: Partial<ConstructorParameters<typeof GitAdapter>[0]> = {}): Promise<Served> {
  const adapter = new GitAdapter({ port, git: s.bin, exitGraceMs: NEVER, stopGraceMs: NEVER, ...options });
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
  await listenIn(server);
  onTestFinished(() => { adapter.stop(); server.closeAllConnections(); server.close(); });
  const hook = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret`;
  return { adapter, server, env: baseEnv(s, { HH_BRIDGE: hook }), hits: () => hits };
}

export async function refusingBridge(s: Stand, status: number): Promise<{ env: Env; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; req.resume(); res.writeHead(status); res.end(); });
  await listenIn(server);
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  return { env: baseEnv(s, { HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret` }), hits: () => hits };
}

/* A bridge that writes the frames a test names, then ends or breaks the connection. */
export async function scriptedBridge(s: Stand, frames: unknown[], ending: 'end' | 'destroy' = 'end'): Promise<Env> {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200);
    const texts = frames.map(frame => (typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`));
    /* A connection that breaks does so once the frames are on their way. */
    if (ending === 'destroy') return void res.write(texts.join(''), () => res.destroy());
    for (const text of texts) res.write(text);
    res.end();
  });
  await listenIn(server);
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  return baseEnv(s, { HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret` });
}

export async function answer(served: Served, body: unknown): Promise<unknown[]> {
  const hook = served.env.HH_BRIDGE!.replace('/hook/', '/git/');
  const response = await fetch(hook, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line) as unknown);
}


/* What the tests of a fetch by the settings of the remote share. */
export const GLOB = '+refs/heads/*:refs/remotes/origin/*';
export const MAIN_ONLY = '+refs/heads/main:refs/remotes/origin/main';
export const FEAT_ONLY = '+refs/heads/feat:refs/remotes/origin/feat';
export const REFUSED = { do: 'say', stderr: 'fatal: unable to access: the requested URL returned error: 503\n', exit: 128 };
const DEFERRED: GitRecordReply = { accepted: true, state: 'deferred', nextAttemptAt: null };

export type Prepare = (work: string) => void;
export const tracking: Prepare = work => { realGit(work, 'checkout', '--quiet', '-b', 'feat', '--track', 'origin/feat'); };
export const noUpstream: Prepare = work => { realGit(work, 'checkout', '--quiet', '--no-track', '-b', 'own', 'origin/feat'); };
export const detached: Prepare = work => { realGit(work, 'checkout', '--quiet', '--detach', 'origin/feat'); };
export const twoLiterals: Prepare = work => {
  realGit(work, 'config', '--replace-all', 'remote.origin.fetch', MAIN_ONLY);
  realGit(work, 'config', '--add', 'remote.origin.fetch', FEAT_ONLY);
};

const fetchHead = (work: string) => readFileSync(join(work, '.git', 'FETCH_HEAD'), 'utf8');
export const refsOf = (work: string) => realGit(work, 'for-each-ref', '--format=%(refname) %(objectname)');
const withoutHornhoof = (text: string) => text.split('\n').filter(line => !line.startsWith('hornhoof-git:')).join('\n');

/* The clone of the agent and a clone left to plain git, side by side, and a way to move the remote behind both. */
export function clones(s: Stand, prepare: Prepare = () => {}): { agent: string; plain: string; moveRemote: () => void } {
  for (const branch of ['feat', 'zeta']) realGit(s.work, 'push', '--quiet', 'origin', `main:refs/heads/${branch}`);
  const clone = (name: string) => {
    const work = join(s.dir, name);
    realGit(s.dir, 'clone', '--quiet', s.url, work);
    prepare(work);
    return work;
  };
  const moveRemote = () => {
    for (const branch of ['main', 'feat', 'zeta']) {
      realGit(s.work, 'checkout', '--quiet', '-B', branch, `origin/${branch}`);
      commit(s.work, `more-${branch}`);
      realGit(s.work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
    }
    realGit(s.work, 'tag', 'next');
    realGit(s.work, 'push', '--quiet', 'origin', 'next');
  };
  return { agent: clone('agent'), plain: clone('plain'), moveRemote };
}

export function plainFetch(s: Stand, work: string, args: string[]): Ran {
  const done = spawnSync('/usr/bin/git', args, { cwd: work, encoding: 'utf8', env: { ...baseEnv(s), LC_ALL: 'C.UTF-8' } as NodeJS.ProcessEnv });
  return { stdout: done.stdout, stderr: done.stderr, code: done.status };
}

export function expectSameAsPlain(ran: Ran, plainRan: Ran, agent: string, plain: string): void {
  expect(ran.code).toBe(plainRan.code);
  expect(ran.stdout).toBe(plainRan.stdout);
  expect(withoutHornhoof(ran.stderr)).toBe(plainRan.stderr);
  expect(fetchHead(agent)).toBe(fetchHead(plain));
  expect(refsOf(agent)).toBe(refsOf(plain));
}

/* The first attempt is refused and the command waits for the next one. */
export async function refusedFirst(s: Stand, work: string, args: string[] = ['fetch', 'origin'], replies: GitRecordReply[] = [DEFERRED]) {
  planFor(s, { fetch: [REFUSED] });
  const port = new FakePort();
  port.replies = [...replies];
  const served = await serve(s, port);
  const ran = runShim(args, work, served.env);
  await eventually(() => port.recorded.length === 1 && ran.partial().stderr.includes('keeps waiting'));
  return { port, ran, ...served };
}
