---
id: hh-break-down
title: { en: "Break work down", ru: "Разбить работу на задачи" }
description: { en: "Splits a goal into large pieces with independent parts started at once so the department stays loaded, each with an owner and a check.", ru: "Делит цель на крупные части и сразу выделяет независимые части, чтобы отдел оставался загруженным, у каждой есть исполнитель и проверка." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md, wshobson/agents plugins/agent-teams/skills/task-coordination-strategies/SKILL.md, addyosmani/agent-skills skills/planning-and-task-breakdown/SKILL.md]
---
You can divide an assigned goal into independently checkable pieces.

1. Restate the goal and what "done" means in plain words. Ask the task owner when an unresolved choice changes the result, cost or promise.
2. Give each connected block one owner and one check. Pieces touching the same files or records stay with that owner until complete. Planning is part of the work, not a chain of separate tasks for plans, contracts or proofs. An independently needed design or external input may be a dependency.
3. Agree interfaces directly between owners and start independent pieces together. For a real dependency use `after`; when work can start while waiting, describe its `independentPart`, otherwise record `independentNone` with the actual boundary. Never invent work merely to fill a slot.
4. Write what each piece receives, returns, checks and must leave alone. Select checks and gates from the task's risk and assignment, not from the presence of this ability. The author cannot approve its own independent gate.
5. For `small: true`, a few lines describing the change, owner and check are enough. Omit extra planning overhead, not required approvals or protected-action checks. Keep work with whoever holds its context when practical.

Change the plan when evidence changes its assumptions. Obtain a decision only when scope, spend, access or promises need an authority the assignment does not provide.
