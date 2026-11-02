---
id: hh-fix-loop
title: { en: "Fix loop", ru: "Цикл исправлений" }
description: { en: "Sends failed work back with the findings, and escalates after a few rounds.", ru: "Возвращает неудачную работу с замечаниями и поднимает вопрос выше после нескольких кругов." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
When a check or a gate finds problems:

1. Send the work back to the member who did it with every finding that blocks, at once: what failed, where, and the evidence. Not "make it better". What does not block goes as a note under a pass.
2. At a gate of one task, the same gate checks again after the fix, and checks only the fixes. After the review of a turn nobody checks again. A fix is proved by the check that failed now passing, not by a new opinion.
3. Count the rounds. After three rounds on the same task, give it to a stronger tier or another member with the full history.
4. After five rounds, or when two members disagree about what is right, stop and take it to whoever gave you the goal with both positions and your recommendation.

Do not lower the bar to end a loop. A finding you decide not to fix is a decision; write down why and what it costs if you are wrong.
