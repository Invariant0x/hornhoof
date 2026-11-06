---
id: hh-report-to-head
title: { en: "Report to your head", ru: "Отчет руководителю" }
description: { en: "Ends every piece of work with a short status your head can act on.", ru: "Завершает каждую работу коротким статусом, по которому руководитель может действовать." }
kind: core
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md]
---
For a completed task marked `small: true`, submit a line stating what changed and the commit SHA. Detailed reports, matrices and metrics belong to the shared turn review and checks. Use the structured summary below for other tasks; if small work grows, tell the head and take the normal path.

For completed Development author work, ordinary or small, submit the tests written, green affected-test result from run_tests and commit SHA in a short line. The test engineer or QA owns the remaining checks once per turn on the final candidate. Use the structured summary below when reporting a blocker or concern, not to demand final metrics from an author.

When you submit a task or say it is blocked, write a short summary in this shape:

- **Status**: one of DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT.
- **What changed**: the files, records or documents you touched, by name.
- **Evidence**: the command you ran and what it printed, the link you checked, the number you recomputed. A claim without evidence is not done.
- **Concerns**: anything you doubt, skipped or could not verify, said plainly.
- **Next**: what you need from your head, or what should happen next.

BLOCKED means you cannot go on without someone else; name who and what. NEEDS_CONTEXT means the task is unclear; ask the one question that unblocks you. Your head, not you, decides what to do with a concern. Ask teammates about the work with message_employee; other departments only through your head and the orchestrator.
