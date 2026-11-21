import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readGitAncestry } from '../src/modules/testruns/git-ancestry.js';

type RunOptions = { cwd?: string; detached?: boolean; env?: NodeJS.ProcessEnv; signal?: AbortSignal };
type FakeChild = EventEmitter & { pid: number; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
type Handler = (args: string[], options: RunOptions, child: FakeChild) => void;
type CallRecord = { file: string; args: string[]; options: RunOptions; child: FakeChild };

const mocks = vi.hoisted(() => {
  let nextPid = 41_000;
  let handler: Handler = (_args, _options, child) => {
    queueMicrotask(() => child.emit('close', 0, null));
  };
  const calls: CallRecord[] = [];
  const makeChild = () => Object.assign(new EventEmitter(), { pid: nextPid++, stdout: new PassThrough(), kill: vi.fn() }) as FakeChild;
  const spawn = vi.fn((file: string, args: string[], options: RunOptions) => {
    const child = makeChild();
    calls.push({ file, args, options, child });
    handler(args, options, child);
    return child;
  });
  const execFile = vi.fn((file: string, args: string[], options: RunOptions, done: (error: (Error & { code?: number | string }) | null, stdout: string) => void) => {
    const child = makeChild();
    calls.push({ file, args, options, child });
    let stdout = '';
    let settled = false;
    const finish = (err: (Error & { code?: number | string }) | null) => {
      if (settled) return;
      settled = true;
      done(err, stdout);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.once('close', (code: number | null) => {
      if (code === 0) finish(null);
      else finish(Object.assign(new Error('Git stopped.'), { code: code ?? 'ABORT_ERR' }));
    });
    options.signal?.addEventListener('abort', () => finish(Object.assign(new Error('Aborted.'), { code: 'ABORT_ERR' })), { once: true });
    handler(args, options, child);
    return child;
  });
  return {
    calls,
    spawn,
    execFile,
    setHandler(next: Handler) { handler = next; },
    reset() {
      calls.length = 0;
      nextPid = 41_000;
      spawn.mockClear();
      execFile.mockClear();
      handler = (_args, _options, child) => { queueMicrotask(() => child.emit('close', 0, null)); };
    },
  };
});

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));

const head = 'a'.repeat(40);
const ancestor = 'b'.repeat(40);
const repo = { url: 'https://github.com/acme/shop.git', token: 'fixture-token' };

beforeEach(() => { mocks.reset(); });
afterEach(() => { vi.restoreAllMocks(); });

function emitResult(child: FakeChild, code: number, stdout = ''): void {
  queueMicrotask(() => {
    if (stdout) child.stdout.write(stdout);
    child.stdout.end();
    child.emit('close', code, null);
  });
}

it.each([[0, true], [1, false], [128, null]] as const)('checks the exact Git objects, interpreting merge-base exit %s', async (code, expected) => {
  mocks.setHandler((args, _options, child) => {
    if (args.includes('merge-base')) return emitResult(child, code);
    emitResult(child, 0, args.includes('cat-file') ? 'commit\n' : '');
  });
  expect(await readGitAncestry(repo, head, ancestor, 10_000)).toBe(expected);
  const fetch = mocks.calls.find(call => call.args.includes('fetch'))!;
  expect(fetch.options.detached).toBe(true);
  expect(fetch.args).toEqual(expect.arrayContaining(['--filter=tree:0', '--no-recurse-submodules', 'http.followRedirects=false', 'gc.auto=0']));
  expect(fetch.args.slice(-4)).toEqual(['--', repo.url, head, ancestor]);
  expect(JSON.stringify({ args: fetch.args, env: fetch.options.env })).not.toContain(repo.token);
  expect(mocks.calls.at(-1)!.args.slice(-4)).toEqual(['merge-base', '--is-ancestor', ancestor, head]);
});

it('leaves ancestry unknown before Git runs for untrusted repositories or unpinned refs', async () => {
  expect(await readGitAncestry({ ...repo, url: 'https://github.com.example.test/acme/shop.git' }, head, ancestor, 10_000)).toBeNull();
  expect(await readGitAncestry(repo, 'main', ancestor, 10_000)).toBeNull();
  expect(mocks.calls).toHaveLength(0);
});

it('returns false without merge-base when a verified object is not a commit', async () => {
  mocks.setHandler((args, _options, child) => {
    emitResult(child, 0, args.includes('cat-file') ? 'blob\n' : '');
  });
  expect(await readGitAncestry(repo, head, ancestor, 10_000)).toBe(false);
  expect(mocks.calls.some(call => call.args.includes('merge-base'))).toBe(false);
});

it('kills the detached process group on timeout and waits for child exit before removing scratch', async () => {
  let fetchPid = 0;
  let fetchChild: FakeChild | undefined;
  let fetchScratch = '';
  let fetchDetached: boolean | undefined;
  let scratchExistedAtKill = false;
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (fetchChild && pid === -fetchPid && signal === 'SIGKILL') {
      scratchExistedAtKill = existsSync(fetchScratch);
      setTimeout(() => fetchChild!.emit('close', null, 'SIGKILL'), 15);
    }
    return true;
  });

  mocks.setHandler((args, options, child) => {
    if (args.includes('fetch')) {
      fetchPid = child.pid;
      fetchChild = child;
      fetchDetached = options.detached;
      fetchScratch = options.cwd ?? args[args.indexOf('--git-dir') + 1] ?? '';
      return;
    }
    emitResult(child, 0);
  });

  expect(await readGitAncestry(repo, head, ancestor, 40)).toBeNull();
  expect(fetchDetached).toBe(true);
  expect(killSpy).toHaveBeenCalledWith(-fetchPid, 'SIGKILL');
  expect(scratchExistedAtKill).toBe(true);
  expect(existsSync(fetchScratch)).toBe(false);
});

it('kills the detached process group and returns null when stdout exceeds the cap', async () => {
  const byPid = new Map<number, FakeChild>();
  const killedPids: number[] = [];
  let catScratch = '';
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const child = signal === 'SIGKILL' && pid < 0 ? byPid.get(-pid) : undefined;
    if (child) {
      killedPids.push(-pid);
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
    }
    return true;
  });

  mocks.setHandler((args, options, child) => {
    if (args.includes('cat-file')) {
      byPid.set(child.pid, child);
      catScratch = options.cwd ?? args[args.indexOf('--git-dir') + 1] ?? '';
      queueMicrotask(() => { child.stdout.write('x'.repeat(20_000)); });
      return;
    }
    emitResult(child, 0);
  });

  expect(await readGitAncestry(repo, head, ancestor, 100)).toBeNull();
  expect(killedPids.length).toBeGreaterThan(0);
  expect(existsSync(catScratch)).toBe(false);
});

it('deduplicates concurrent identical ancestry lookups into one Git fetch', async () => {
  let releaseFetch: (() => void) | undefined;
  mocks.setHandler((args, _options, child) => {
    if (args.includes('fetch')) {
      releaseFetch = () => emitResult(child, 0);
      return;
    }
    emitResult(child, 0, args.includes('cat-file') ? 'commit\n' : '');
  });

  const lookups = Array.from({ length: 5 }, () => readGitAncestry(repo, head, ancestor, 10_000));
  await vi.waitFor(() => expect(releaseFetch).toBeDefined());
  expect(mocks.calls.filter(call => call.args.includes('fetch'))).toHaveLength(1);
  releaseFetch!();
  expect(await Promise.all(lookups)).toEqual([true, true, true, true, true]);
});

it('caps concurrent distinct Git fetches and frees slots after completion', async () => {
  const pending: (() => void)[] = [];
  mocks.setHandler((args, _options, child) => {
    if (args.includes('fetch')) {
      pending.push(() => emitResult(child, 0));
      return;
    }
    emitResult(child, 0, args.includes('cat-file') ? 'commit\n' : '');
  });

  const shas = ['1', '2', '3', '4', '5', '6'].map(ch => ch.repeat(40));
  const lookups = shas.map(nextHead => readGitAncestry(repo, nextHead, ancestor, 10_000));
  await vi.waitFor(() => expect(pending).toHaveLength(4));
  expect(await Promise.all(lookups.slice(4))).toEqual([null, null]);
  expect(pending).toHaveLength(4);
  for (const finish of pending) finish();
  expect(await Promise.all(lookups.slice(0, 4))).toEqual([true, true, true, true]);
  expect(await readGitAncestry(repo, '7'.repeat(40), ancestor, 10_000)).toBe(true);
});

it('returns null cleanly when git fails to spawn or init exits non-zero', async () => {
  mocks.setHandler((_args, _options, child) => {
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
  });
  expect(await readGitAncestry(repo, head, ancestor, 10_000)).toBeNull();

  mocks.setHandler((args, _options, child) => {
    emitResult(child, args.includes('init') ? 1 : 0);
  });
  expect(await readGitAncestry(repo, head, ancestor, 10_000)).toBeNull();
});
