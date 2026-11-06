---
id: hh-handle-reports
title: { en: "Handle reports", ru: "Разбирать отчеты" }
description: { en: "Reads each member's report, checks the evidence and decides the next step.", ru: "Читает отчет каждого сотрудника, проверяет доказательства и решает, что дальше." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
For a completed `small: true` task, accept the change and commit SHA line and read its affected-test result; reports and metrics belong to the shared turn review.

For every member report:

- **DONE**: verify the evidence matches the brief's check; spot-check one claim when leaving the department, then pass on or start the next task.
- **DONE_WITH_CONCERNS**: accept (saying why), fix in a new task, or escalate; never drop a concern.
- **BLOCKED**: unblock inside the department if you can; otherwise ask via the orchestrator, and explain any remaining `human_only_action` in plain words without commands or code.
- **NEEDS_CONTEXT**: answer with "comment" on the task to reopen it; keep the body unchanged.

Success without evidence is not done. Read finished work in the tracker instead of asking.
