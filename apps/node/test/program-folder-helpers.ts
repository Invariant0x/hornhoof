import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RULES = 'The rules of this repository.\n';

const inGit = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });

/* A real repository that tracks its own AGENTS.md, and a task's worktree of it, the way a node lays them out: the worktree T
   is the repository's folder right inside the task's context folder C. */
export function taskTree(root = mkdtempSync(join(tmpdir(), 'hh-tree-')), tracked: Record<string, string> = {}) {
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  inGit(source, 'init', '--quiet');
  for (const [path, text] of Object.entries({ 'AGENTS.md': RULES, 'README.md': 'A repository.\n', ...tracked })) {
    mkdirSync(join(source, path, '..'), { recursive: true });
    writeFileSync(join(source, path), text);
  }
  inGit(source, 'add', '.');
  inGit(source, 'commit', '--quiet', '-m', 'first');
  const context = join(root, 'task-workspaces', 'one');
  mkdirSync(context, { recursive: true });
  const tree = join(context, 'repo');
  inGit(source, 'worktree', 'add', '--quiet', '-b', 'task-one', tree);
  return { source, context, tree, status: () => inGit(tree, 'status', '--porcelain') };
}
