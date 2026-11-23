import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { runJob, type ProviderAdapter, type RunInput, type RunResult } from '../src/runner.js';
import { ASKPASS, gitPreparationFailure, prepareRepo, type Git } from '../src/workspace.js';
import { listenIn } from '../../../test-support/ports.mjs';

const AGENT = '7d3c2a10-0000-4000-8000-000000000001';
const TOKEN = 'ghp_repotoken0123456789';
const REPO = { url: 'https://github.com/acme/shop.git', branch: 'release', token: TOKEN };

type JobRun = Extract<ServerMessage, { type: 'job.run' }>;
const job = (over: Partial<JobRun> = {}): JobRun => ({
  type: 'job.run', jobId: 'job-1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 2_147_483_647 - 30_000, secret: null, instructions: null, toolToken: null, ...over,
});

function fakeAdapter(result: (input: RunInput) => Partial<RunResult> = () => ({}), owner?: ProviderAdapter['owner']): ProviderAdapter & { inputs: RunInput[] } {
  const inputs: RunInput[] = [];
  return {
    inputs,
    owner,
    install: async () => {},
    loggedIn: async () => true,
    login: async () => {},
    secrets: async () => [],
    run: async input => {
      inputs.push(input);
      return { ok: true, sessionId: 'sess-1', result: 'done', output: '', error: null, limits: null, ...result(input) };
    },
  };
}

/* git as the node calls it: what it was asked, and a clone that leaves a .git folder behind. */
const NOTED = ['config', '--local', '--get', 'hornhoof.username'];
const originAnswer = (args: string[], origin: string): string => args.join(' ') === 'remote get-url origin' ? origin : '';

function fakeGit(origin = REPO.url) {
  const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv; user: unknown }[] = [];
  const git: Git = async (args, opts) => {
    calls.push({ args, ...opts });
    if (args[0] === 'clone') mkdirSync(join(args.at(-1)!, '.git'), { recursive: true });
    return originAnswer(args, origin);
  };
  return { git, calls };
}

/* The package store a turn gets when the node's own environment names none, under the work folder of a node whose agents
   share one user. The node leaves a name alone that its environment already sets, so a test that looks at the whole
   environment of a turn first clears both names, and then no host decides what it sees. */
const STORE_NAMES = ['PNPM_STORE_DIR', 'npm_config_cache'];
function withoutHostStore(): void {
  for (const name of STORE_NAMES) vi.stubEnv(name, '');
  onTestFinished(() => { vi.unstubAllEnvs(); });
}
const storeOf = (dir: string) => ({ PNPM_STORE_DIR: join(dir, 'work', '.pkg-store', 'pnpm'), npm_config_cache: join(dir, 'work', '.pkg-store', 'npm') });

describe("an agent's folder and its repository", () => {
  it('keeps a folder per job for a job without a workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const { git, calls } = fakeGit();
    const adapter = fakeAdapter();
    await runJob(adapter, job(), dir, { git });
    expect(adapter.inputs[0]!.workDir).toBe(join(dir, 'work', 'job-1'));
    expect(calls).toEqual([]);
  });

  it('works in the agent folder without git when there is no repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const { git, calls } = fakeGit();
    const adapter = fakeAdapter();
    await runJob(adapter, job({ workspace: { key: AGENT, repo: null } }), dir, { git });
    expect(adapter.inputs[0]!.workDir).toBe(join(dir, 'work', 'agents', AGENT));
    expect(calls).toEqual([]);
  });

  it('clones the repository into the agent folder with the token only in the environment', async () => {
    withoutHostStore();
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const { git, calls } = fakeGit();
    const adapter = fakeAdapter();
    const done = await runJob(adapter, job({ workspace: { key: AGENT, repo: REPO } }), dir, { git });
    const folder = join(dir, 'work', 'agents', AGENT);
    expect(done.ok).toBe(true);
    /* With no author named, it looks only whether it set one before. */
    expect(calls.map(c => c.args)).toEqual([['clone', '--quiet', '--branch', 'release', '--', REPO.url, join(folder, 'shop')], NOTED]);
    expect(calls.flatMap(c => c.args).join(' ')).not.toContain(TOKEN);
    expect(calls[0]!.env).toMatchObject({ GIT_ASKPASS: ASKPASS, HH_GIT_PASSWORD: TOKEN, HH_GIT_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0' });
    expect(calls[0]!.env.NODE_KEY).toBeUndefined();
    expect(adapter.inputs[0]!.workDir).toBe(folder);
    expect(adapter.inputs[0]!.env).toEqual({ GIT_ASKPASS: ASKPASS, HH_GIT_PASSWORD: TOKEN, HH_GIT_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0', ...storeOf(dir) });
  });

  it('reuses the clone on the next turn and follows a repository that moved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const first = fakeGit();
    await runJob(fakeAdapter(), job({ workspace: { key: AGENT, repo: REPO } }), dir, { git: first.git });
    const again = fakeGit();
    await runJob(fakeAdapter(), job({ jobId: 'job-2', workspace: { key: AGENT, repo: REPO } }), dir, { git: again.git });
    expect(again.calls.map(c => c.args)).toEqual([['remote', 'get-url', 'origin'], NOTED]);
    const moved = fakeGit('https://github.com/acme/old-shop.git');
    await runJob(fakeAdapter(), job({ jobId: 'job-3', workspace: { key: AGENT, repo: REPO } }), dir, { git: moved.git });
    expect(moved.calls.map(c => c.args)).toEqual([
      ['remote', 'get-url', 'origin'],
      ['remote', 'set-url', 'origin', REPO.url],
      NOTED,
    ]);
    expect(moved.calls[0]!.cwd).toBe(join(dir, 'work', 'agents', AGENT, 'shop'));
  });

  it("sets the commit author Hornhoof names in the clone on every turn, and leaves the clone's own otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const author = { name: 'Alex Rivera', email: 'alex@acme.example' };
    const first = fakeGit();
    await runJob(fakeAdapter(), job({ workspace: { key: AGENT, repo: { ...REPO, author } } }), dir, { git: first.git });
    const clone = join(dir, 'work', 'agents', AGENT, 'shop');
    const sets = [
      ['config', '--', 'user.name', 'Alex Rivera'],
      ['config', '--', 'user.email', 'alex@acme.example'],
      ['config', '--', 'hornhoof.username', 'Alex Rivera'],
      ['config', '--', 'hornhoof.useremail', 'alex@acme.example'],
    ];
    expect(first.calls.slice(1).map(c => [c.args, c.cwd])).toEqual(sets.map(args => [args, clone]));
    const again = fakeGit();
    await runJob(fakeAdapter(), job({ jobId: 'job-2', workspace: { key: AGENT, repo: { ...REPO, author } } }), dir, { git: again.git });
    expect(again.calls.map(c => c.args)).toEqual([['remote', 'get-url', 'origin'], ...sets]);
  });

  it('takes away the author it set once Hornhoof names none, and leaves one the clone was given otherwise', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (args: string[], cwd: string) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    const origin = join(dir, 'shop');
    mkdirSync(origin);
    git(['init', '--quiet', '-b', 'main'], origin);
    git(['-c', 'user.name=Seed', '-c', 'user.email=seed@acme.example', 'commit', '--quiet', '--allow-empty', '-m', 'Start'], origin);
    const work = join(dir, 'work');
    mkdirSync(work);
    const repo = { url: origin, branch: 'main', token: '', author: { name: 'Alex Rivera', email: 'alex@acme.example' } };
    const owner = { user: null, home: dir };
    const clone = join(work, 'shop');
    const local = (key: string) => git(['config', '--local', '--get', key], clone).stdout.trim() || null;
    await prepareRepo(work, repo, owner);
    expect([local('user.name'), local('user.email')]).toEqual(['Alex Rivera', 'alex@acme.example']);
    await prepareRepo(work, { ...repo, author: null }, owner);
    expect([local('user.name'), local('user.email'), local('hornhoof.username')]).toEqual([null, null, null]);
    git(['config', 'user.name', 'Maria'], clone);
    await prepareRepo(work, { ...repo, author: null }, owner);
    expect(local('user.name')).toBe('Maria');
  });

  it('leaves out the askpass helper for a public repository without a token', async () => {
    withoutHostStore();
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const { git, calls } = fakeGit();
    const adapter = fakeAdapter();
    await runJob(adapter, job({ workspace: { key: AGENT, repo: { ...REPO, token: '' } } }), dir, { git });
    expect(calls[0]!.env.GIT_ASKPASS).toBeUndefined();
    expect(adapter.inputs[0]!.env).toEqual({ GIT_TERMINAL_PROMPT: '0', ...storeOf(dir) });
  });

  it('hides the repository token in everything that goes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const { git } = fakeGit();
    const events: unknown[] = [];
    const adapter = fakeAdapter(input => {
      input.onEvent?.({ kind: 'text', text: `pushed with ${TOKEN}` });
      return { result: `token ${TOKEN}`, output: `remote: ${TOKEN}` };
    });
    const done = await runJob(adapter, job({ workspace: { key: AGENT, repo: REPO } }), dir, { git, onEvent: e => events.push(e) });
    expect(JSON.stringify([done, events])).not.toContain(TOKEN);
    expect(done.result).toBe('token [hidden]');
  });

  it('fails the turn with git\'s reason, without the token, when the clone fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const git: Git = async () => {
      throw new Error(`fatal: Authentication failed for ${TOKEN}`);
    };
    const adapter = fakeAdapter();
    const done = await runJob(adapter, job({ workspace: { key: AGENT, repo: REPO } }), dir, { git });
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toContain('Authentication failed for [hidden]');
    expect(adapter.inputs).toEqual([]);
  });

  it('refuses a folder in the way of the clone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    mkdirSync(join(dir, 'work', 'agents', AGENT, 'shop'), { recursive: true });
    writeFileSync(join(dir, 'work', 'agents', AGENT, 'shop', 'notes.txt'), 'mine');
    const { git, calls } = fakeGit();
    const done = await runJob(fakeAdapter(), job({ workspace: { key: AGENT, repo: REPO } }), dir, { git });
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toContain('./shop');
    expect(calls).toEqual([]);
  });

  it("hands the folder to the key's user and runs git as that user on the built-in node", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const prepared: string[] = [];
    const user = { uid: 20001, gid: 20001 };
    const { git, calls } = fakeGit();
    const adapter = fakeAdapter(() => ({}), { user, home: join(dir, 'subs', 's1'), prepare: path => void prepared.push(path) });
    await runJob(adapter, job({ workspace: { key: AGENT, repo: REPO } }), dir, { git });
    expect(prepared).toEqual([join(dir, 'work', 'agents', AGENT)]);
    expect(calls[0]).toMatchObject({ user, env: { HOME: join(dir, 'subs', 's1') } });
  });

  it('starts a fresh session when the saved one worked in another folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ws-'));
    const adapter = fakeAdapter();
    await runJob(adapter, job({ jobId: 'old' }), dir);
    await runJob(adapter, job({ jobId: 'new', sessionId: 'sess-1', workspace: { key: AGENT, repo: null } }), dir);
    expect(adapter.inputs[1]).toMatchObject({ workDir: join(dir, 'work', 'agents', AGENT), sessionId: null });
    expect(existsSync(join(dir, 'work', 'agents', AGENT))).toBe(true);
  });
});

describe('the askpass helper in the image', () => {
  const helper = join(import.meta.dirname, '..', 'git-askpass');
  const ask = (prompt: string) => spawnSync('sh', [helper, prompt], { env: { HH_GIT_PASSWORD: TOKEN, HH_GIT_HOST: 'github.com' }, encoding: 'utf8' }).stdout;

  it("gives git the turn's token as the password and a fixed name", () => {
    expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(`${TOKEN}\n`);
    expect(ask("Username for 'https://github.com': ")).toBe('x-access-token\n');
  });

  it("answers nothing for any other host, so the token never leaves for one", () => {
    expect(ask("Password for 'https://x-access-token@gitlab.com': ")).toBe('');
    expect(ask("Username for 'https://evil.example': ")).toBe('');
    expect(ask("Password for 'https://x-access-token@github.com.evil.example': ")).toBe('');
    expect(ask("Password for 'https://github.com@evil.example': ")).toBe('');
  });
});

describe('with real git', () => {
  it.each(['§', 'Q7x', 'abc-def'])('masks every known Git credential before retaining stderr: %s', token => {
    const error = gitPreparationFailure({ kind: 'child', exitCode: 7, signal: null, osCode: null, stderr: `${'z'.repeat(9000)} ${token} ${Buffer.from(token).toString('base64')}`, stderrTruncated: false }, true, [token]);
    expect(error.outcome.stderr).not.toContain(token);
    expect(error.outcome.stderr).toContain('[hidden] [hidden]');
    expect(error.outcome.stderr).toHaveLength(8192);
    expect(error.outcome.stderrTruncated).toBe(true);
  });

  it('captures a typed preparation failure with fixed real Git instead of recursing through PATH', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hh-git-capture-'));
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const marker = join(base, 'shim-used');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf shim > '${marker}'\nexit 19\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const server = createServer((_req, res) => { res.writeHead(503); res.end('Temporarily unavailable'); });
    await listenIn(server);
    onTestFinished(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing controlled Git endpoint.');
    const repo = { url: `http://127.0.0.1:${address.port}/shop.git`, branch: 'main', token: TOKEN };
    let error: unknown;
    try { await prepareRepo(base, repo, { user: null, home: base }); } catch (caught) { error = caught; }
    expect(existsSync(marker)).toBe(false);
    expect(error).toMatchObject({ network: true, outcome: { kind: 'child', exitCode: 128, signal: null, stderrTruncated: false } });
    expect(JSON.stringify({ error, message: String(error) })).not.toContain(TOKEN);
    expect((error as { outcome: { stderr: string } }).outcome.stderr).toContain('503');
  });

  it('clones a branch once, then keeps the clone and the work in it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hh-git-'));
    const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
    const origin = join(base, 'shop');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'release');
    writeFileSync(join(origin, 'README.md'), 'shop');
    git(origin, 'add', '.');
    git(origin, 'commit', '-q', '-m', 'first');
    const work = join(base, 'agent');
    mkdirSync(work);
    const repo = { url: origin, branch: 'release', token: '' };
    await prepareRepo(work, repo, { user: null, home: null });
    expect(git(join(work, 'shop'), 'branch', '--show-current').stdout.trim()).toBe('release');
    writeFileSync(join(work, 'shop', 'draft.txt'), 'work in progress');
    await prepareRepo(work, repo, { user: null, home: null });
    expect(existsSync(join(work, 'shop', 'draft.txt'))).toBe(true);
  });
});
