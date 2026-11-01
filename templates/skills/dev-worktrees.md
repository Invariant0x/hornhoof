---
id: dev-worktrees
title: { en: "Branches and workspaces", ru: "Ветки и рабочие копии" }
description: { en: "Gives every task its own branch and clean workspace, and finishes branches tidily.", ru: "Дает каждой задаче свою ветку и чистую рабочую копию и аккуратно завершает ветки." }
kind: procedure
sources: [obra/superpowers skills/using-git-worktrees/SKILL.md, obra/superpowers skills/finishing-a-development-branch/SKILL.md]
---
- Every task runs on its own branch, named after the task, in its own workspace (a git worktree from the shared clone), so members working at once never touch each other's files.
- Before work starts the workspace is clean and the tests of the part you will change pass on it. A red baseline is reported, not built upon.
- Nobody works on the main branch. Only a release that passed every gate and the CEO's approval reaches it.
- A task branch starts from the turn's branch, which holds what earlier tasks merged, or from the main line while there is none. When the task is done, the tests of what it changed pass and the branch is pushed for review with its brief, commits and test output.
- Once its gates pass, its executor merges it into the turn's branch the wake names; the final check runs on that branch (dev-gates). After the release, its workspace is removed and the branch deleted.
- A workspace with uncommitted files is never deleted without asking; those files exist nowhere else.
- Never force-push a shared branch and never rewrite history someone else built on.
