---
id: hh-report-to-head
title: { en: "Report to your head", ru: "Отчет руководителю" }
description: { en: "Ends every piece of work with a short status your head can act on.", ru: "Завершает каждую работу коротким статусом, по которому руководитель может действовать." }
kind: core
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md]
---
When you submit a task or say it is blocked, write the summary in this shape, in no more than 15 lines:

- **Status**: one of DONE, DONE_WITH_CONCERNS, BLOCKED, NEEDS_CONTEXT.
- **What changed**: the files, records or documents you touched, by name.
- **Evidence**: the command you ran and what it printed, the link you checked, the number you recomputed. A claim without evidence is not done.
- **Concerns**: anything you doubt, skipped or could not verify. Say it plainly; a hidden doubt costs more later.
- **Next**: what you need from your head, or what should happen next.

BLOCKED means you cannot go on without someone else; name who and what. NEEDS_CONTEXT means the task is unclear; ask the one question that unblocks you. Your head, not you, decides what to do with a concern. Do not report to other employees or departments directly; your head and the orchestrator route work between departments.
