import { execFile, type ExecFileException } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoFolder, type ExternalGitOutcome, type Workspace } from '@hornhoof/protocol';
import type { JobUser } from './isolation.js';
import { secretPrefixLength } from './redact.js';

type Repo = NonNullable<Workspace['repo']>;

/* In the node's image: prints the token from HH_GIT_PASSWORD when git asks for a password. The token never sits in a
   command line, an address or the clone's settings. The name has no KEY, SECRET or TOKEN in it, so Codex passes it on. */
export const ASKPASS = '/app/git-askpass';
const GIT_TIMEOUT_MS = 5 * 60_000;

export type Git = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; user: JobUser | null }) => Promise<string>;

type ChildOutcome = Extract<ExternalGitOutcome, { kind: 'child' }>;

/* Git credentials are known values, including short passwords. Hold a possible
   prefix across chunks and mask it before a bounded stderr tail discards data. */
export class GitCredentialMask {
  private held = '';
  private readonly forms: string[];
  private readonly pattern: RegExp | null;

  constructor(secrets: string[]) {
    this.forms = [...new Set(secrets.filter(Boolean).flatMap(value => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]).flatMap(value => [value, value.replace(/=+$/, '')]))].filter(Boolean).sort((a, b) => b.length - a.length);
    this.pattern = this.forms.length ? new RegExp(this.forms.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  }

  push(chunk: string): string {
    const combined = this.held + chunk;
    const text = this.pattern ? combined.replace(this.pattern, '[hidden]') : combined;
    const keep = secretPrefixLength(text, this.forms);
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  flush(): string {
    const text = this.held ? '[hidden]' : '';
    this.held = '';
    return text;
  }
}

/* Evidence from an owned preparation child, not a retry decision or proof that
   the whole check slot and cache have settled. The runner supplies that receipt. */
export class GitPreparationError extends Error {
  constructor(readonly outcome: ChildOutcome, readonly network: boolean, action: string) {
    super(`Git ${action} preparation failed: ${outcome.stderr || outcome.osCode || 'The child did not complete successfully.'}`);
    this.name = 'GitPreparationError';
  }
}

export function gitPreparationFailure(outcome: ChildOutcome, network: boolean, secrets: string[], action = 'command'): GitPreparationError {
  const mask = new GitCredentialMask(secrets);
  const text = (mask.push(outcome.stderr) + mask.flush()).replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[hidden]@').trim();
  return new GitPreparationError({ ...outcome, stderr: text.slice(-8192), stderrTruncated: outcome.stderrTruncated || text.length > 8192 }, network, action);
}

function childFailure(error: ExecFileException, stderr: string): ChildOutcome {
  return { kind: 'child', exitCode: typeof error.code === 'number' ? error.code : null, signal: error.signal ?? null, osCode: typeof error.code === 'string' ? error.code : null, stderr, stderrTruncated: false };
}

export const realGit: Git = (args, { cwd, env, user }) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/git', args, { cwd, env, uid: user?.uid, gid: user?.gid, timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(gitPreparationFailure(childFailure(err, String(stderr)), ['clone', 'fetch', 'ls-remote'].includes(args[0] ?? ''), [env.HH_GIT_PASSWORD ?? ''], args[0]));
      else resolve(String(stdout).trim());
    });
  });

/* What the agent's program gets for the turn, so its own git commands reach the repository too. The helper answers only
   the repository's host, so a clone from anywhere else never gets the token. */
export function gitEnv(repo: Pick<Repo, 'url' | 'token'>): Record<string, string> {
  return repo.token ? { GIT_ASKPASS: ASKPASS, HH_GIT_PASSWORD: repo.token, HH_GIT_HOST: new URL(repo.url).host, GIT_TERMINAL_PROMPT: '0' } : { GIT_TERMINAL_PROMPT: '0' };
}

type Owner = { user: JobUser | null; home: string | null };

/* The commit a clone or worktree of the agent stands at, read as the agent's user, or null when it names none. */
export async function headOf(dir: string, owner: Owner, git: Git = realGit): Promise<string | null> {
  const head = await git(['rev-parse', '--verify', 'HEAD'], { cwd: dir, user: owner.user, env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: owner.home ?? process.env.HOME ?? dir, GIT_TERMINAL_PROMPT: '0' } }).catch(() => '');
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
}

/* Preserve an author the clone was given separately from Hornhoof's setting. */
async function setRepoAuthor(author: Repo['author'], run: (args: string[]) => Promise<string>): Promise<void> {
  const AUTHOR = [['user.name', 'hornhoof.username'], ['user.email', 'hornhoof.useremail']] as const;
  if (author) {
    const values = [author.name, author.email];
    for (const [i, [key]] of AUTHOR.entries()) await run(['config', '--', key, values[i]!]);
    for (const [i, [, note]] of AUTHOR.entries()) await run(['config', '--', note, values[i]!]);
  } else {
    const local = (key: string) => run(['config', '--local', '--get', key]).catch(() => '');
    if (!(await local(AUTHOR[0][1]))) return;
    for (const [key, note] of AUTHOR) {
      const noted = await local(note);
      if (noted && (await local(key)) === noted) await run(['config', '--local', '--unset', key]);
      await run(['config', '--local', '--unset', note]).catch(() => '');
    }
  }
}

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
  /* Set each turn, so a changed author reaches clones made before. Hornhoof notes the author it set, so one taken away in
     Hornhoof leaves the clone too, while one the clone was given otherwise stays. */
  await setRepoAuthor(repo.author, args => run(args, target));
  return env;
}
