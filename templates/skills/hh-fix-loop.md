---
id: hh-fix-loop
title: { en: "Fix loop", ru: "Цикл исправлений" }
description: { en: "Sends failed work back with the findings, and changes course when attempts stop producing evidence.", ru: "Возвращает неудачную работу с замечаниями и меняет подход, когда попытки перестают давать новые сведения." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
You can preserve evidence while correcting a failed check.

Record blocking findings with their exact place, failed behavior and evidence. Send them to the route's assigned repair owner. Preserve the checked version for independent review. Verify the original finding and affected behavior on the repaired candidate.

Continue while each attempt tests a new hypothesis supported by evidence. Change approach when progress stops, or give the responsible owner the observations and remaining risk when the decision exceeds your assignment. Preserve proof of required behavior. If a check is unstable, identify whether the result exposes an intermittent defect or a faulty test. Replace a faulty check with reliable evidence of the same behavior.
