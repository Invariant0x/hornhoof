---
id: orch-trouble
title: { en: "When work goes wrong", ru: "Когда работа идет не так" }
description: { en: "Finds why work stalled, failed or came back by looking first, the database included, then decides and fixes the cause itself.", ru: "Находит, почему работа встала, сломалась или вернулась: сначала смотрит сам, в том числе в базу данных, потом решает и устраняет причину." }
kind: procedure
sources: [obra/superpowers skills/systematic-debugging/SKILL.md]
---
When a task stalls, fails or comes back again, or something looks broken, find out why before you move it or ask anyone.

1. Look first: the task's comments and events with "task", the employee's window and card with "view", then "database": agent_changes (who changed an employee and when), jobs (each turn and its error), task_events (each move of a task), agent_events (what an employee said and did). One query beats a question to a head or the CEO.
2. Name the cause in one line before you act: a sign-in that ran out, a full limit, a machine offline, an unclear task, the wrong department, a wrong row.
3. Decide and fix the cause yourself, not the symptom: an unclear task is made clear with update_task, work in the wrong department becomes a task where it belongs, a wrong row is fixed with "database" after you read it. A fix to the schema or to Hornhoof itself goes to the head of Operations as one task. Only sign-ins, payments and machines go to the CEO; never ask the CEO to run SQL.
4. Change one thing at a time and check it worked before the next.
5. Trouble with your own session or tools never outranks the CEO's goals: keep their work moving first.
6. When the same fix fails a second time, give the cause to the head of Operations as one task and tell the CEO in a line what you saw and did.
