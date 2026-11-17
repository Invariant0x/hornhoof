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

/* Takes away the agent's worktrees of closed tasks, which hold the task's dependencies and fill the machine's disk. Only a
   worktree in the agent's folder, on a task's branch, of a task that is done or cancelled, with nothing uncommitted in it and
   every commit of it on the remote, pushed or merged there, goes, the way git itself removes one, so the clone's list of
   worktrees stays right; its branch stays in the clone. The clone itself and every other worktree stay. It says in one line
   what went, and why each closed task's worktree that stays could not go. */
export async function removeClosedCopies(checkout: string, agentDir: string, tasks: TaskStates, owner: Owner, git: Git = realGit): Promise<string[]> {
  /* git reads settings of the agent's own that can run programs, so it runs there as the agent's user, never as root. */
  if (!owner.user && isRootUser()) return ["The worktrees of closed tasks stay: git would run in the agent's folder as root."];
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: owner.home ?? process.env.HOME ?? agentDir, GIT_TERMINAL_PROMPT: '0' };
  const run = (args: string[], cwd: string) => git(args, { cwd, env, user: owner.user });
  const folder = real(agentDir), open = new Set(tasks.open), lines: string[] = [];
  if (!folder) return lines;
  let removed = 0;
  for (const tree of treesOf(await run(['worktree', 'list', '--porcelain', '-z'], checkout)).slice(1)) {
    const task = tree.branch ? TASK_BRANCH.exec(tree.branch) : null;
    const n = task ? Number(task[1]) : 0, at = real(tree.path);
    if (!task || n > tasks.upTo || open.has(n) || tree.prunable || !at?.startsWith(folder + sep)) continue;
    const kept = (reason: string) => lines.push(`Kept the worktree of closed task #${n} at ${tree.path}: ${reason}.`);
    if (tree.locked) {
      kept('it is locked');
      continue;
    }
    try {
      if (await run(['status', '--porcelain', '--ignore-submodules=none'], tree.path)) {
        kept('it has changes that are not committed');
        continue;
      }
      /* Its commits that no branch of the remote has: none once they are pushed, or merged into a branch that is. */
      const ahead = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], tree.path);
      if (ahead !== '0') {
        kept(ahead === '1' ? '1 commit of it is not on the remote' : /^\d+$/.test(ahead) ? `${ahead} commits of it are not on the remote` : 'git could not tell whether its commits are on the remote');
        continue;
      }
      await run(['worktree', 'remove', tree.path], checkout);
    } catch (err) {
      kept(`git could not remove it: ${why(err)}`);
      continue;
    }
    removed++;
    lines.push(`Removed the worktree of closed task #${n} at ${tree.path}.`);
  }
  if (removed) await run(['worktree', 'prune'], checkout).catch((err: unknown) => lines.push(`git could not prune the list of worktrees of ${checkout}: ${why(err)}.`));
  return lines;
}
