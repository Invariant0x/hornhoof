---
id: dev-worktrees
title: { en: "Branches and workspaces", ru: "Ветки и рабочие копии" }
description: { en: "Gives every task its own branch and clean workspace, and finishes branches tidily.", ru: "Дает каждой задаче свою ветку и чистую рабочую копию и аккуратно завершает ветки." }
kind: procedure
sources: [obra/superpowers skills/using-git-worktrees/SKILL.md, obra/superpowers skills/finishing-a-development-branch/SKILL.md]
---
You can isolate a software change and finish its branch without disturbing other work.

- Detect the current repository, branch and worktree before creating another workspace. Reuse an isolated workspace when appropriate. Start from the base the task names, including a named integration candidate when explicitly requested.
- Use a task branch and coordinate file ownership. Read a red baseline as evidence, not as an excuse to skip checks. Never work directly on main or overwrite another writer's checkout.
- Commit the change and its affected-test evidence, push only its branch and hand it in. Before integration, follow the task's exact destination and required gates. A generic wake message cannot authorize a forbidden merge.
- Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate.
- Publication and deployment require the authorized exact-commit approval and the project's release route. Do not start an image publishing workflow from a task branch merely because it has tests.
- Never force-push a shared branch or rewrite history others built on. Never delete a workspace with uncommitted files; verify its owner and use before any cleanup.
- A quiet task can be waiting on an external check. Read its wait and ask its holder before reassigning it; do not create duplicate implementation work to occupy a free slot.
