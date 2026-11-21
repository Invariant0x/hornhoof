import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubName } from './github-limit.js';
import type { RepoAddress } from './refs.js';

export type GitAncestryReader = (repo: RepoAddress, head: string, ancestor: string, timeoutMs: number) => Promise<boolean | null>;
type GitResult = { code: number | null; stdout: string };
const SHA = /^[0-9a-f]{40}$/;
const ANCESTRY_CODES: Record<number, boolean> = { 0: true, 1: false };
const MAX_STDOUT = 16_384;
const MAX_CONCURRENT = 4;
const flags = ['-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '-c', 'protocol.version=2'];
const baseEnv = {
  PATH: process.env.PATH,
  GIT_ALLOW_PROTOCOL: 'https',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function killGroup(child: ChildProcess): void {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* Fall back to direct kill if the group already exited. */ }
  }
  child.kill('SIGKILL');
}

/* Runs git in a detached process group so timeout or excessive output kills git and its remote helpers
   and waits for close before the caller deletes the scratch directory. */
function git(args: string[], cwd: string, signal: AbortSignal): Promise<GitResult> {
  if (signal.aborted) return Promise.resolve({ code: null, stdout: '' });
  return new Promise(resolve => {
    const child = spawn('git', [...flags, ...args], { cwd, env: baseEnv, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let stdout = '', bytes = 0, killed = false, settled = false;
    const stop = () => {
      if (killed) return;
      killed = true;
      killGroup(child);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', stop);
      resolve({ code: killed ? null : code, stdout });
    };
    signal.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_STDOUT) return stop();
      stdout += chunk.toString('utf8');
    });
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
  });
}

async function verifyCommits(args: string[], scratch: string, head: string, ancestor: string, signal: AbortSignal): Promise<boolean | null> {
  const types = await Promise.all([head, ancestor].map(sha => git([...args, 'cat-file', '-t', sha], scratch, signal)));
  if (types.some(type => type.code !== 0)) return null;
  return types.every(type => type.stdout.trim() === 'commit');
}

async function fetchAndCheckAncestry(scratch: string, name: string, head: string, ancestor: string, signal: AbortSignal): Promise<boolean | null> {
  const initialized = await git(['init', '--bare', '--template=', '--', scratch], scratch, signal);
  if (initialized.code !== 0) return null;
  const args = ['--git-dir', scratch];
  const fetched = await git([...args, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--filter=tree:0', '--', `https://github.com/${name}.git`, head, ancestor], scratch, signal);
  if (fetched.code !== 0) return null;
  const commits = await verifyCommits(args, scratch, head, ancestor, signal);
  if (commits !== true) return commits;
  const compared = await git([...args, 'merge-base', '--is-ancestor', ancestor, head], scratch, signal);
  return compared.code === null ? null : (ANCESTRY_CODES[compared.code] ?? null);
}

const inFlight = new Map<string, Promise<boolean | null>>();
let active = 0;

async function runAncestry(name: string, head: string, ancestor: string, timeoutMs: number): Promise<boolean | null> {
  active++;
  let scratch: string | undefined;
  try {
    scratch = await mkdtemp(join(tmpdir(), 'hh-ancestry-'));
    return await fetchAndCheckAncestry(scratch, name, head, ancestor, AbortSignal.timeout(timeoutMs));
  } catch { return null; }
  finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
    active--;
  }
}

/* A full commit graph of two exact SHAs from a public GitHub repository, without downloading their files. */
export const readGitAncestry: GitAncestryReader = async (repo, head, ancestor, timeoutMs) => {
  const name = githubName(repo.url);
  if (!name || !SHA.test(head) || !SHA.test(ancestor)) return null;
  const key = `${name.toLowerCase()}\0${head}\0${ancestor}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  if (active >= MAX_CONCURRENT) return null;
  const run = runAncestry(name, head, ancestor, timeoutMs);
  inFlight.set(key, run);
  try { return await run; }
  finally { inFlight.delete(key); }
};
