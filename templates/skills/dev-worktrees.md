---
id: dev-worktrees
kind: procedure
sources: [obra/superpowers skills/using-git-worktrees/SKILL.md, obra/superpowers skills/finishing-a-development-branch/SKILL.md]
---
You can isolate a software change and finish its branch without disturbing other work.

- Detect the current repository, branch and worktree before creating another workspace. Reuse an isolated workspace when appropriate. Start from the base the task names, including a named integration candidate when explicitly requested.
- Use a task branch and coordinate file ownership. Read a red baseline as evidence, not as an excuse to skip checks. Never work directly on main or overwrite another writer's checkout.
- Commit the change to its assigned branch and put the check evidence in the hand-in. Commit evidence only when the project or assignment requires a durable artifact. Before integration, follow the task's exact destination and required gates. A generic wake message cannot authorize a forbidden merge.
- External Review and Security engineers work only in echelon tasks. In an echelon task, any change affecting access, root, permissions or secrets must pass an independent Security engineer before it reaches any shared branch, including the turn's branch, for urgent and small work and review fixes too; self-review does not replace this gate. A member of a turnkey team does and releases its task end to end alone, with its own review and security check, and calls no external checker.
- Publication and deployment require the authorized exact-commit approval and the project's release route. Do not start an image publishing workflow from a task branch merely because it has tests.
- Never force-push a shared branch or rewrite history others built on. Never delete a workspace with uncommitted files; verify its owner and use before any cleanup.
- A quiet task can be waiting on an external check. Read its wait and ask its holder before reassigning it; do not create duplicate implementation work to occupy a free slot.
