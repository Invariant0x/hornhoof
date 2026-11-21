import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import type { TaskStates } from '@hornhoof/protocol';
import { isRootUser, type JobUser } from './isolation.js';
import { GitPreparationError, realGit, type Git } from './workspace.js';

type Owner = { user: JobUser | null; home: string | null };
type Tree = { path: string; branch: string | null; locked: boolean; prunable: boolean };

/* The branch of a task's work as Hornhoof names it: task-<n>, or task-<n>-<more>. */
const TASK_BRANCH = /^task-(\d+)(?:-|$)/;

/* git's own list of the clone's worktrees, the clone itself first. */
function treesOf(listed: string): Tree[] {
  return listed.split('\0\0').map(record => record.split('\0').filter(Boolean)).filter(fields => fields[0]?.startsWith('worktree ')).map(fields => ({
    path: fields[0]!.slice('worktree '.length),
    branch: fields.find(f => f.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
    locked: fields.some(f => f === 'locked' || f.startsWith('locked ')),
    prunable: fields.some(f => f === 'prunable' || f.startsWith('prunable ')),
  }));
}

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const why = (err: unknown) => (err instanceof GitPreparationError ? err.outcome.stderr : err instanceof Error ? err.message : String(err)).split('\n').map(l => l.trim()).find(Boolean) ?? 'no reason was given';

/* What git ignores in a copy that comes back by itself: installed dependencies, builds, caches and test output, a folder or
   a file of that name at any depth, or a file ending so. A closed task's worktree goes only when all it ignores is of these;
   anything else git ignores is on no remote, so the worktree stays for a person to see. */
export const REBUILDABLE = ['node_modules', 'dist', 'build', '.cache', 'coverage', '.next', '.nuxt', '.turbo', '.parcel-cache', '.vite', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'target', '.gradle', 'test-results', 'playwright-report', 'blob-report', 'e2e/results', '.eslintcache', '.DS_Store', '*.tsbuildinfo'] as const;

/* Whether a path git lists as ignored, a folder with its slash, is of what comes back by itself. */
export function rebuildable(entry: string): boolean {
  const path = `/${entry.replace(/\/$/, '')}`;
  return REBUILDABLE.some(name => (name.startsWith('*.') ? path.endsWith(name.slice(1)) : path.endsWith(`/${name}`) || path.includes(`/${name}/`)));
}

/* What git ignores in a worktree, from ls-files with --directory: a folder ignored whole is one entry, and git also lists
   the folders not in the repository that hold what it ignores, which are left out here as their entries stand for them. */
function ownIgnored(listed: string): string[] {
  const entries = listed.split('\0').filter(Boolean);
  return entries.filter(entry => !(entry.endsWith('/') && entries.some(other => other !== entry && other.startsWith(entry))));
}

const named = (paths: string[]) => (paths.length > 5 ? `${paths.slice(0, 5).join(', ')} and ${paths.length - 5} more` : paths.join(', '));

/* Why a closed task's worktree stays. */
export type KeptWhy = 'locked' | 'uncommitted' | 'unpushed' | 'ignored' | 'failed';
export type ClosedCopy = { path: string; task: number } & ({ removed: true } | { removed: false; why: KeptWhy; reason: string; ignored?: string[] });
export type CloneRun = (args: string[], cwd: string) => Promise<string>;

/* git in the agent's folder as the agent's user, never as root: git reads settings of the agent's own that can run
   programs. Null where it would run as root. */
export function agentGit(agentDir: string, owner: Owner, git: Git = realGit): CloneRun | null {
  if (!owner.user && isRootUser()) return null;
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: owner.home ?? process.env.HOME ?? agentDir, GIT_TERMINAL_PROMPT: '0' };
  return (args, cwd) => git(args, { cwd, env, user: owner.user });
}

const notPushed = (ahead: string) =>
  ahead === '1' ? '1 commit of it is not on the remote' : /^\d+$/.test(ahead) ? `${ahead} commits of it are not on the remote` : 'git could not tell whether its commits are on the remote';

type StayReason = { why: KeptWhy; reason: string; ignored?: string[] };

/* Why a finished task's worktree must stay now, or null if everything in it is on a remote or rebuildable. */
async function keepReason(run: CloneRun, path: string): Promise<StayReason | null> {
  if (await run(['status', '--porcelain', '--ignore-submodules=none'], path)) {
    return { why: 'uncommitted', reason: 'it has changes that are not committed' };
  }
  /* Its commits that no branch of the remote has: none once they are pushed, or merged into a branch that is. */
  const ahead = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], path);
  if (ahead !== '0') {
    return { why: /^\d+$/.test(ahead) ? 'unpushed' : 'failed', reason: notPushed(ahead) };
  }
  const ignored = ownIgnored(await run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], path)).filter(entry => !rebuildable(entry));
  if (ignored.length) {
    return { why: 'ignored', reason: `it holds what git ignores and no remote has: ${named(ignored)}`, ignored };
  }
  return null;
}

/* Takes away the agent's worktrees of closed tasks, which hold the task's dependencies and fill the machine's disk. Only a
   worktree in the agent's folder, on a task's branch, of a task that is done or cancelled, with nothing uncommitted in it,
   every commit of it on the remote, pushed or merged there, and only rebuildable ignored files goes, the way git itself
   removes one, so the clone's list of worktrees stays right; its branch stays in the clone. The clone itself and every other
   worktree stay. It names each closed task's worktree, whether it went, and why one that stays could not go. When removing is
   given (e.g. to measure size before removal), the copy is checked again after it returns, right before git removes it. */
export async function closedCopies(checkout: string, agentDir: string, tasks: TaskStates, run: CloneRun, removing?: (path: string) => Promise<void>): Promise<{ copies: ClosedCopy[]; problem: string | null }> {
  const folder = real(agentDir), open = new Set(tasks.open), copies: ClosedCopy[] = [];
  if (!folder) return { copies, problem: null };
  for (const tree of treesOf(await run(['worktree', 'list', '--porcelain', '-z'], checkout)).slice(1)) {
    const task = tree.branch ? TASK_BRANCH.exec(tree.branch) : null;
    const n = task ? Number(task[1]) : 0, at = real(tree.path);
    if (!task || n > tasks.upTo || open.has(n) || tree.prunable || !at?.startsWith(folder + sep)) continue;
    const kept = (why: KeptWhy, reason: string) => copies.push({ path: tree.path, task: n, removed: false, why, reason });
    if (tree.locked) {
      kept('locked', 'it is locked');
      continue;
    }
    try {
      let stay = await keepReason(run, tree.path);
      if (!stay && removing) {
        await removing(tree.path);
        stay = await keepReason(run, tree.path);
      }
      if (stay) {
        copies.push({ path: tree.path, task: n, removed: false, ...stay });
        continue;
      }
      await run(['worktree', 'remove', tree.path], checkout);
    } catch (err) {
      kept('failed', `git could not remove it: ${why(err)}`);
      continue;
    }
    copies.push({ path: tree.path, task: n, removed: true });
  }
  let problem: string | null = null;
  if (copies.some(c => c.removed)) await run(['worktree', 'prune'], checkout).catch((err: unknown) => (problem = `git could not prune the list of worktrees of ${checkout}: ${why(err)}.`));
  return { copies, problem };
}

/* The same, said in one line for each closed task's worktree, for the node's log at the start of an agent's turn. */
export async function removeClosedCopies(checkout: string, agentDir: string, tasks: TaskStates, owner: Owner, git: Git = realGit): Promise<string[]> {
  const run = agentGit(agentDir, owner, git);
  if (!run) return ["The worktrees of closed tasks stay: git would run in the agent's folder as root."];
  const { copies, problem } = await closedCopies(checkout, agentDir, tasks, run);
  const lines = copies.map(c => (c.removed ? `Removed the worktree of closed task #${c.task} at ${c.path}.` : `Kept the worktree of closed task #${c.task} at ${c.path}: ${c.reason}.`));
  return problem ? [...lines, problem] : lines;
}
