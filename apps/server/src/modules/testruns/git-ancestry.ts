import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubName } from './github-limit.js';
import type { RepoAddress } from './refs.js';

export type GitAncestryReader = (repo: RepoAddress, head: string, ancestor: string, timeoutMs: number) => Promise<boolean | null>;
const SHA = /^[0-9a-f]{40}$/;
const flags = ['-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null', '-c', 'maintenance.auto=false', '-c', 'protocol.version=2'];
const baseEnv = {
  PATH: process.env.PATH,
  GIT_ALLOW_PROTOCOL: 'https',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args: string[], signal: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    execFile('git', [...flags, ...args], { signal, env: baseEnv, maxBuffer: 16_384, encoding: 'utf8' }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout });
    });
  });
}

/* merge-base --is-ancestor exits 0 for an ancestor and 1 for none; any other exit is no answer. */
const ANCESTRY = new Map<number | null, boolean>([[0, true], [1, false]]);

/* The two commits fetched into a fresh bare repository, graph only, and whether one is under the other. None where a step
   failed or either SHA is no commit. */
async function ancestryIn(scratch: string, url: string, head: string, ancestor: string, signal: AbortSignal): Promise<boolean | null> {
  const initialized = await git(['init', '--bare', '--template=', '--', scratch], signal);
  if (initialized.code !== 0) return null;
  const args = ['--git-dir', scratch];
  const fetched = await git([...args, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--filter=tree:0', '--', url, head, ancestor], signal);
  if (fetched.code !== 0) return null;
  const types = await Promise.all([head, ancestor].map(sha => git([...args, 'cat-file', '-t', sha], signal)));
  if (!types.every(result => result.code === 0 && result.stdout.trim() === 'commit')) return null;
  const compared = await git([...args, 'merge-base', '--is-ancestor', ancestor, head], signal);
  return ANCESTRY.get(compared.code) ?? null;
}

/* A full commit graph of two exact SHAs from a public GitHub repository, without downloading their files. */
export const readGitAncestry: GitAncestryReader = async (repo, head, ancestor, timeoutMs) => {
  const name = githubName(repo.url);
  if (!name || !SHA.test(head) || !SHA.test(ancestor)) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  const scratch = await mkdtemp(join(tmpdir(), 'hh-ancestry-')).catch(() => null);
  if (!scratch) return null;
  try { return await ancestryIn(scratch, `https://github.com/${name}.git`, head, ancestor, signal); }
  catch { return null; }
  finally { await rm(scratch, { recursive: true, force: true }).catch(() => {}); }
};
