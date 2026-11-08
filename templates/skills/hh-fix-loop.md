---
id: hh-fix-loop
title: { en: "Fix loop", ru: "Цикл исправлений" }
description: { en: "Sends failed work back with the findings, and escalates after a few rounds.", ru: "Возвращает неудачную работу с замечаниями и поднимает вопрос выше после нескольких кругов." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
You can resolve a failed check without lowering its standard or repeating unrelated work.

When `task.echelons` is present, its current stage owner keeps Review or Security findings and fixes within the assigned scope, then hands the verified candidate forward. Never return an ordinary finding to the original author. A wrong goal goes to the head with the requirement, candidate and evidence preserved. A content failure in Tests also goes to the head; infrastructure failures wait or retry the same candidate. Keep source findings and fix candidates distinct, record each finding once, and retain independent approval for sensitive fixes before shared integration.

For a legacy task without an echelon route, use the assigned fix loop below.

1. Return every blocking finding to the responsible author at once: exact place, failed behavior and evidence. Keep nonblocking observations as notes.
2. Reproduce the finding, then prove the fix with the affected check on the corrected version. Read existing valid evidence rather than repeating checks already proved on that exact candidate.
3. Use the task's gates and assignment to decide who accepts the fix. A scoped repeat checks the original findings and new breakage in the changed range; it does not reopen an entire review by default. Independent approvals for sensitive or protected actions still apply before those actions, including urgent or small fixes.
4. After three ineffective rounds, involve a stronger or different owner with the full history. After five, or a substantive disagreement, give the task owner both positions, the evidence and your recommendation.

A finding not fixed is an explicit decision with a reason and cost if wrong. Never weaken a test, check or threshold to end the loop.
