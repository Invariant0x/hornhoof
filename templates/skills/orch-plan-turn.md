---
id: orch-plan-turn
title: { en: "Lay out a turn", ru: "Разложить ход" }
description: { en: "Gives each of the CEO's goals to one department as one whole task a head can start without asking, with a check that shows it is done.", ru: "Отдает каждую цель CEO одному отделу одной целой задачей, которую руководитель может начать без вопросов, с проверкой, что она готова." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md]
---
## Small-task fast path

At assignment, the head decides whether a task is small: a change in a single place, with a clear result, no dependencies, and finishable by a developer in a work turn. Mark it `small: true` in `create_task` or `update_task`. State the change and its check briefly; assign it to an executor without splitting or separate gates. The executor writes a failing test, makes the change, runs only affected tests, merges into the turn's branch, and submits a line stating what changed and the commit SHA. Reports, matrices, complexity metrics and duplicate checks belong to the shared turn review and checks. If the task grows beyond this definition, the executor tells the head and follows the normal path.

Give small work to the developer already working in that area and holding its context; do not search for a free developer or start a new chain. They fit it between their own steps, otherwise right after the current piece. If they have several tasks ahead, give it to a free developer. They keep it in a separate small commit on the turn's branch, submit the line, and return to their own work.

For other work: a turn holds the CEO's goals for it. Each goal is one task for the one department that owns it end to end.

1. Each task says what to build and how anyone can tell it is done: a check a person or a test can make, with the CEO's exact values in it (names, numbers, texts, dates, addresses).
2. No task says "handle edge cases", "TBD" or "as discussed". Write what it means.
3. Planning is part of doing: no separate tasks for plans, contracts or proofs. Only work another department alone can do (an account, a design) becomes a second task, which says what it hands over.
4. A new ask while a turn runs goes into the next turn, unless the CEO says "now". The running turn keeps its goals.
5. Split by what must come first, never by size. Everything that can be built without the checked result of another part is one turn, however large: each head splits it among its members, and pieces that wait for each other inside it get `after`. Start a new turn only when a part needs the one before it reviewed, tested and released first, or when the CEO has to see a result before deciding what comes next. Order the turns so each one leaves something that works and can be shown.
6. Give each area one owner; a second task on it or hot files is never assigned until the first merges, and every wait has an owner and a deadline.
7. Before you call plan_turn, read every task as the head who gets it: could they start without asking you? If not, add what is missing.
