---
id: hh-break-down
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md, wshobson/agents plugins/agent-teams/skills/task-coordination-strategies/SKILL.md, addyosmani/agent-skills skills/planning-and-task-breakdown/SKILL.md]
---
You can divide an assigned goal into independently checkable pieces.

1. Restate the goal and what "done" means in plain words. Ask the task owner when an unresolved choice changes the result, cost or promise.
2. Give each connected block one owner and one check. Pieces touching the same files or records stay with that owner until complete. Planning is part of the work, not a chain of separate tasks for plans, contracts or proofs. An independently needed design or external input may be a dependency.
3. One piece changes one repository. Where the department keeps several, its own and one per product (taskRepositories in "briefing"), name the product whose repository the piece changes, or none for the department's own. A change across repositories is a piece per repository, with `after` only where one needs another's merged commit.
4. Agree interfaces directly between owners and start independent pieces together. For a real dependency use `after`; when work can start while waiting, describe its `independentPart`, otherwise record `independentNone` with the actual boundary. Never invent work merely to fill a slot.
5. Write what each piece receives, returns, checks and must leave alone. Select checks and gates from the task's risk and assignment, not from the presence of this ability. The author cannot approve its own independent gate.
6. For `small: true`, a few lines describing the change, owner and check are enough. Omit extra planning overhead, not required approvals or protected-action checks. Keep work with whoever holds its context when practical.
7. **Stop rule for sub-tasks.** Make a sub-task only when it is a result a person can check on its own (`independent_result`), needs other skills, another department or an independent checker (`other_owner`), or runs at the same time as its siblings and shortens the whole (`parallel_block`); pass that as `subtaskReason`. Anything else is a checklist step in the body of its task. Tasks go 3 levels deep at most; a task has at most 3 sub-tasks without its head's approval and never more than 5. A task with one sub-task is that sub-task: assign it directly. The parent's title names the whole result: Hornhoof shows it above the child's where you make one, so fix a title that is narrower than its whole.
8. **Checkpoints.** Commit and push each finished piece to its own branch before the next. A finished tree leaves exactly one merged result and none of its own branches open; a task of one step still ends with a push.

Whoever gives out the work answers for keeping the department loaded. Members standing free while work in the department can run are a fault, not a normal wait. Never assign ordinary or non-urgent work to members of an urgent-only team (`urgentOnly`); use an eligible owner instead.

Change the plan when evidence changes its assumptions. Obtain a decision only when scope, spend, access or promises need an authority the assignment does not provide.
