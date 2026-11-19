---
id: hh-report-to-head
title: { en: "Report to your head", ru: "Отчет руководителю" }
description: { en: "Ends every piece of work with a short status your head can act on.", ru: "Завершает каждую работу коротким статусом, по которому руководитель может действовать." }
kind: core
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md]
---
You can report a result so its owner can act on the evidence.

Write results, identifiers, quantities and outcomes in separate readable words.

For completed `small: true` work, give a line with the change, checked version and result. Detailed reports, matrices and a shared turn review are included only when the assignment requires them. For a blocker or concern use this short structure:

- **Status:** DONE, DONE_WITH_CONCERNS, BLOCKED or NEEDS_CONTEXT.
- **What changed:** exact files, records or documents.
- **Evidence:** the executed command and output, checked record or recomputed total, on the actual version.
- **Concerns:** missing checks, uncertain facts and material limitations.
- **Next:** the decision or condition the task owner needs to handle.

BLOCKED names what cannot proceed and who can resolve it. NEEDS_CONTEXT asks the one question that changes the work. Do not turn an author check into a claim that unrun final checks passed. Use the submission itself rather than sending duplicate reports to multiple people. Ask teammates directly about findings and route other-department needs through the authorized coordinator.
