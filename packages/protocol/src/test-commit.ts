import { z } from 'zod';

/* A commit's full object name: 40 hex digits, or 64 in a repository on SHA-256. A shorter name may come to mean another
   commit, and a branch's name surely will, so what a run proves is tied to this and nothing less. */
export const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const CommitSha = z.string().regex(COMMIT_SHA);

/* The branch named after a task, among a repository's branches: task-<n> itself, or the only one that starts with
   task-<n>-. */
export function ownBranch(names: string[], task: number): { branch: string } | { problem: string } {
  const own = `task-${task}`;
  if (names.includes(own)) return { branch: own };
  const mine = names.filter(n => n.startsWith(`${own}-`)).sort();
  if (mine.length === 1) return { branch: mine[0]! };
  if (mine.length) return { problem: `Several branches belong to task ${task}: ${mine.join(', ')}. Name the one to test.` };
  return { problem: `The repository has no branch ${own} or ${own}-... Push the task's branch, or name the branch to test.` };
}
