import { realpathSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { TaskStates } from '@hornhoof/protocol';
import { isRootUser, type JobUser } from './isolation.js';
import { GitPreparationError, realGit, type Git } from './workspace.js';

type Owner = { user: JobUser | null; home: string | null };
export type Tree = { path: string; branch: string | null; locked: boolean; prunable: boolean };

/* The branch of a task's work or release check as Hornhoof names it: task-<n> or release-check-<n>. */
const TASK_BRANCH = /^(?:task|release-check)-(\d+)(?:-|$)/;

/* git's own list of the clone's worktrees, the clone itself first. */
export function treesOf(listed: string): Tree[] {
  return listed.split('\0\0').map(record => record.split('\0').filter(Boolean)).filter(fields => fields[0]?.startsWith('worktree ')).map(fields => ({
    path: fields[0]!.slice('worktree '.length),
    branch: fields.find(f => f.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
    locked: fields.some(f => f === 'locked' || f.startsWith('locked ')),
    prunable: fields.some(f => f === 'prunable' || f.startsWith('prunable ')),
  }));
}

function taskOfFolder(folderName: string, cloneBase = ''): number {
  const byBranch = TASK_BRANCH.exec(folderName);
  if (byBranch) return Number(byBranch[1]);
  if (cloneBase && folderName.startsWith(`${cloneBase}-`)) {
    const tail = folderName.slice(cloneBase.length + 1);
    if (/^\d+$/.test(tail)) return Number(tail);
  }
  return 0;
}

/* Which task a worktree or clone is on, or 0 when it is on none (such as main or a turn branch). A detached worktree
   falls back to its folder name when named task-<n>, release-check-<n>, or <clone>-<n>. */
export function taskOfTree(tree: Tree, cloneBase = ''): number {
  if (tree.branch) {
    const match = TASK_BRANCH.exec(tree.branch);
    return match ? Number(match[1]) : 0;
  }
  return taskOfFolder(basename(tree.path), cloneBase);
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
async function keepReason(run: CloneRun, path: string, allRefs = false): Promise<StayReason | null> {
  if (allRefs) {
    if (!(await run(['remote'], path)).trim()) {
      return { why: 'unpushed', reason: 'it has no remote' };
    }
    if ((await run(['stash', 'list'], path)).trim()) {
      return { why: 'uncommitted', reason: 'it has stashed changes' };
    }
  }
  if (await run(['status', '--porcelain', '--ignore-submodules=none'], path)) {
    return { why: 'uncommitted', reason: 'it has changes that are not committed' };
  }
  /* Its commits that no branch of the remote has: none once they are pushed, or merged into a branch that is. */
  const ahead = await run(['rev-list', '--count', allRefs ? '--all' : 'HEAD', '--not', '--remotes'], path);
  if (ahead !== '0') {
    return { why: /^\d+$/.test(ahead) ? 'unpushed' : 'failed', reason: notPushed(ahead) };
  }
  const ignored = ownIgnored(await run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], path)).filter(entry => !rebuildable(entry));
  if (ignored.length) {
    return { why: 'ignored', reason: `it holds what git ignores and no remote has: ${named(ignored)}`, ignored };
  }
  return null;
}

function remoteRepoName(url: string): string {
  const trimmed = url.trim().replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf(':'));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

async function standaloneTaskOfFolder(base: string, agentDir: string, clone: string, run: CloneRun): Promise<number> {
  const byBranch = TASK_BRANCH.exec(base);
  if (byBranch) {
    const originUrl = await run(['remote', 'get-url', 'origin'], clone).catch(() => '');
    return originUrl && remoteRepoName(originUrl) === base ? 0 : Number(byBranch[1]);
  }
  const bySuffix = /^(.+)-(\d+)$/.exec(base);
  if (!bySuffix) return 0;
  const [, prefix, num] = bySuffix;
  if ((await lstat(join(agentDir, prefix!, '.git')).catch(() => null))?.isDirectory()) return Number(num);
  const originUrl = await run(['remote', 'get-url', 'origin'], clone).catch(() => '');
  return originUrl && remoteRepoName(originUrl) === prefix ? Number(num) : 0;
}

/* A standalone clone made specifically for one task (folder named task-<n>, release-check-<n>, or <repo>-<n>, checked out on
   that task's branch, with no linked worktrees). Primary clones have no task suffix over their repo name and are never matched. */
export async function standaloneClosedCopy(
  clone: string,
  agentDir: string,
  tasks: TaskStates,
  run: CloneRun,
  removing?: (path: string) => Promise<void>,
): Promise<ClosedCopy | null> {
  const folder = real(agentDir), at = real(clone);
  if (!folder || !at?.startsWith(folder + sep)) return null;
  const folderTask = await standaloneTaskOfFolder(basename(clone), agentDir, clone, run);
  if (folderTask <= 0 || folderTask > tasks.upTo || tasks.open.includes(folderTask)) return null;
  const listed = treesOf(await run(['worktree', 'list', '--porcelain', '-z'], clone).catch(() => ''));
  if (listed.length !== 1) return null;
  const head = listed[0]!;
  const branchMatch = head.branch ? TASK_BRANCH.exec(head.branch) : null;
  if (!branchMatch || Number(branchMatch[1]) !== folderTask) return null;
  if (head.locked) return { path: clone, task: folderTask, removed: false, why: 'locked', reason: 'it is locked' };
  try {
    let stay = await keepReason(run, clone, true);
    if (!stay && removing) {
      await removing(clone);
      stay = await keepReason(run, clone, true);
    }
    if (stay) return { path: clone, task: folderTask, removed: false, ...stay };
    await rm(clone, { recursive: true, force: true });
    return { path: clone, task: folderTask, removed: true };
  } catch (err) {
    return { path: clone, task: folderTask, removed: false, why: 'failed', reason: `could not remove it: ${why(err)}` };
  }
}

/* Takes away the agent's worktrees of closed tasks, which hold the task's dependencies and fill the machine's disk. Only a
   worktree in the agent's folder, on a task's branch (or detached in a task folder), of a task that is done or cancelled, with
   nothing uncommitted in it, every commit of it on the remote, pushed or merged there, and only rebuildable ignored files goes,
   the way git itself removes one, so the clone's list of worktrees stays right; its branch stays in the clone. The clone itself
   and every other worktree stay. It names each closed task's worktree, whether it went, and why one that stays could not go.
   When removing is given (e.g. to measure size before removal), the copy is checked again after it returns, right before git
   removes it. */
export async function closedCopies(checkout: string, agentDir: string, tasks: TaskStates, run: CloneRun, removing?: (path: string) => Promise<void>): Promise<{ copies: ClosedCopy[]; problem: string | null }> {
  const folder = real(agentDir), open = new Set(tasks.open), copies: ClosedCopy[] = [], cloneBase = basename(checkout);
  if (!folder) return { copies, problem: null };
  const allTrees = treesOf(await run(['worktree', 'list', '--porcelain', '-z'], checkout));
  for (const tree of allTrees.slice(1)) {
    const n = taskOfTree(tree, cloneBase), at = real(tree.path);
    if (n <= 0 || n > tasks.upTo || open.has(n) || tree.prunable || !at?.startsWith(folder + sep)) continue;
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
  if (copies.some(c => c.removed) || allTrees.slice(1).some(t => t.prunable)) {
    await run(['worktree', 'prune'], checkout).catch((err: unknown) => (problem = `git could not prune the list of worktrees of ${checkout}: ${why(err)}.`));
  }
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
