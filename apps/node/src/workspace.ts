import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoFolder, type Workspace } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';

type Repo = NonNullable<Workspace['repo']>;

/* In the node's image: prints the token from HH_GIT_PASSWORD when git asks for a password. The token never sits in a
   command line, an address or the clone's settings. The name has no KEY, SECRET or TOKEN in it, so Codex passes it on. */
export const ASKPASS = '/app/git-askpass';
const GIT_TIMEOUT_MS = 5 * 60_000;

export type Git = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; user: JobUser | null }) => Promise<string>;

const realGit: Git = (args, { cwd, env, user }) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, uid: user?.uid, gid: user?.gid, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`));
      else resolve(String(stdout).trim());
    });
  });

/* What the agent's program gets for the turn, so its own git commands reach the repository too. The helper answers only
   the repository's host, so a clone from anywhere else never gets the token. */
export function gitEnv(repo: Repo): Record<string, string> {
  return repo.token ? { GIT_ASKPASS: ASKPASS, HH_GIT_PASSWORD: repo.token, HH_GIT_HOST: new URL(repo.url).host, GIT_TERMINAL_PROMPT: '0' } : { GIT_TERMINAL_PROMPT: '0' };
}

type Owner = { user: JobUser | null; home: string | null };

/* The repository's clone inside the agent's folder: cloned once, then left to the agent, pointed at the address
   Hornhoof has now. A folder of the same name that is no clone stays untouched and the turn fails. */
export async function prepareRepo(workDir: string, repo: Repo, owner: Owner, git: Git = realGit): Promise<Record<string, string>> {
  const name = repoFolder(repo.url);
  const target = join(workDir, name);
  const env = gitEnv(repo);
  const run = (args: string[], cwd: string) =>
    git(args, { cwd, user: owner.user, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: owner.home ?? process.env.HOME ?? workDir, ...env } });
  if (!existsSync(target)) {
    await run(['clone', '--quiet', '--branch', repo.branch, '--', repo.url, target], workDir);
  } else if (!existsSync(join(target, '.git'))) {
    throw new Error(`./${name} in the agent's folder is not a clone of ${repo.url}. Move it away so Hornhoof can clone the repository there.`);
  } else if ((await run(['remote', 'get-url', 'origin'], target)) !== repo.url) {
    await run(['remote', 'set-url', 'origin', repo.url], target);
  }
  return env;
}
