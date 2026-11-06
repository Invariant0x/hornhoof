---
id: hh-handle-reports
title: { en: "Handle reports", ru: "Разбирать отчеты" }
description: { en: "Reads each member's report, checks the evidence and decides the next step.", ru: "Читает отчет каждого сотрудника, проверяет доказательства и решает, что дальше." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
For a completed task marked `small: true`, accept the line stating the change and commit SHA, and read its affected-test result. Do not request a separate report or metrics; those belong to the shared turn review and checks. Handle growing scope or blockers with the head through the normal path.

For every report from a member:

- **DONE**: check the evidence is real and matches the brief's check. Spot-check one claim yourself when the result leaves the department. Then pass it on or start the next task.
- **DONE_WITH_CONCERNS**: decide each concern: accept it (say why), fix it now (a new task), or take it to whoever gave you the goal. Never drop a concern silently.
- **BLOCKED**: remove the blocker inside the department if you can (access, an answer, another member's output). If someone outside the department must act, ask through the orchestrator, naming exactly what is needed; only when a genuine human_only_action remains, explain the situation and options in plain words without commands or code.
- **NEEDS_CONTEXT**: answer the question with "comment" on the task, which opens it again; leave the body as it is.

A report that claims success without evidence is treated as not done. The tracker keeps what each member finished; read it there instead of asking.
