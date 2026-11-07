---
id: orch-trouble
title: { en: "When work goes wrong", ru: "Когда работа идет не так" }
description: { en: "Finds why work stalled, failed or came back, including external service failures, by looking first, the database included, then decides and fixes the cause itself.", ru: "Находит, почему работа встала, сломалась или вернулась, включая внешние сбои: сначала смотрит сам, в том числе в базу данных, потом решает и устраняет причину." }
kind: procedure
sources: [obra/superpowers skills/systematic-debugging/SKILL.md]
---
When a task stalls, fails or comes back again, or something looks broken or unclear, find out why before you move it or ask anyone.

1. Look first: "view", "turns", and the task's comments and events with "task", then "database": agent_changes (who changed an employee and when), jobs (each turn and its error), task_events (each move of a task), agent_events (what an employee said and did). One query beats a question to a head or the CEO. Never ask the CEO to run SQL.
2. Name the cause in one line before you act: a sign-in that ran out, a full limit, a machine offline, an unclear task, the wrong department, a wrong row.
3. Decide and fix the cause yourself, not the symptom: an unclear task is made clear with update_task, work in the wrong department becomes a task where it belongs, a wrong row is fixed with "database" after you read it. Only sign-ins, payments and machines go to the CEO. A fix to the schema or to Hornhoof itself goes to the head of Operations as one task, whose database tool only reads.
4. When the fix needs the computer the server runs on itself (Docker, the system, files outside Hornhoof), run it there with "computer"; while access is closed, ask with "ask_computer_access" and the reason, and go on once the CEO opens it. Never ask the CEO to type commands.
5. Change one thing at a time and check it worked before the next.
6. Trouble with your own session or tools never outranks the CEO's goals: keep their work moving first.
7. When the same internal fix fails a second time, give the cause to the head of Operations as one task and tell the CEO in a line what you saw and did; a transient external service failure needs no diagnosis task unless the service stays broken.

External outages and holds: The rule for holds is in hh-lead-tasks. Decide any hold over an external failure, and its lifting, yourself and communicate it at once in one action to every affected holder, never through a department head's queue. An agent needs no permission for an ordinary retry of a transient external failure. Rules against force pushes, alternate refs, permission changes, irreversible actions and retrying dangerous or non-idempotent actions without checking first remain in full force.
