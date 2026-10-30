---
id: dev-worktrees
title: { en: "Branches and workspaces", ru: "Ветки и рабочие копии" }
description: { en: "Gives every task its own branch and clean workspace, and finishes branches tidily.", ru: "Дает каждой задаче свою ветку и чистую рабочую копию и аккуратно завершает ветки." }
kind: procedure
sources: [obra/superpowers skills/using-git-worktrees/SKILL.md, obra/superpowers skills/finishing-a-development-branch/SKILL.md]
---
- Every task runs on its own branch, named after the task, in its own workspace (a git worktree from the shared clone), so members working at once never touch each other's files.
- Before work starts the workspace is clean and the test suite passes on it. A red baseline is reported, not built upon.
- Nobody works on the main branch. Only a release that passed every gate and the CEO's approval reaches it.
- When a task is done: the suite passes on its branch, the branch is rebased or merged onto the current integration branch, and the suite passes again on the result.
- Then the branch goes to review with its brief, its commits and its test output. After the merge, its workspace is removed and the branch deleted.
- A workspace with uncommitted files is never deleted without asking; those files exist nowhere else.
- Never force-push a shared branch and never rewrite history someone else built on.
