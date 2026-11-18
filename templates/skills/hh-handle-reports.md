---
id: hh-handle-reports
title: { en: "Handle reports", ru: "Разбирать отчеты" }
description: { en: "Reads each member's report, checks the evidence and decides the next step.", ru: "Читает отчет каждого сотрудника, проверяет доказательства и решает, что дальше." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
You can accept or return an assigned result by its evidence.

Read the actual task and its acceptance evidence. Check which assigned gate or decision is still open. Route each missing condition to the responsible owner.

- **DONE:** accept only proved claims and required approvals; inspect an important outward-facing claim independently where the task requires it.
- **DONE_WITH_CONCERNS:** use only after every required condition is proved. Explicitly accept each nonblocking concern with a reason, request a bounded fix, or escalate to the task owner. Never silently drop it.
- **BLOCKED:** resolve the named answer, access or dependency through its actual owner. Do not broaden permissions to make work move.
- **NEEDS_CONTEXT:** answer the question with "comment"; preserve the goal unless it actually changes.

For completed `small: true` work, a line with the change and its check result suffices. Detailed reports and a shared turn review are needed only when assigned. Read recorded progress instead of asking people to repeat it.
