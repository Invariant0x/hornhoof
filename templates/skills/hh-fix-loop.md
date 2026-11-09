---
id: hh-fix-loop
title: { en: "Fix loop", ru: "Цикл исправлений" }
description: { en: "Sends failed work back with the findings, and escalates after a few rounds.", ru: "Возвращает неудачную работу с замечаниями и поднимает вопрос выше после нескольких кругов." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
You can resolve a failed check without lowering its standard or repeating unrelated work.

This loop covers a defect the final check of a candidate sends back to its author, and work outside a route of checking stages. A checking stage in the task's route that repairs its own findings keeps them: they go to that stage's own fix, not this loop.

1. Return every blocking finding to the responsible author at once: exact place, failed behavior and evidence. Keep nonblocking observations as notes.
2. Reproduce the finding, then prove the fix with the affected check on the corrected version. Read existing valid evidence rather than repeating checks already proved on that exact candidate.
3. Use the task's gates and assignment to decide who accepts the fix. A scoped repeat checks the original findings and new breakage in the changed range; it does not reopen an entire review by default. Independent approvals for sensitive or protected actions still apply before those actions, including urgent or small fixes.
4. After three ineffective rounds, involve a stronger or different owner with the full history. After five, or a substantive disagreement, give the task owner both positions, the evidence and your recommendation.

A finding not fixed is an explicit decision with a reason and cost if wrong. Never weaken a test, check or threshold to end the loop. The one exception is an unstable test, one that passes and fails on the same code: it may be weakened or deleted, never skipped, and a check of access rights, identity or secret redaction is never weakened.
