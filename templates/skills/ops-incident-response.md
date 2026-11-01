---
id: ops-incident-response
title: { en: "Incident response", ru: "Реагирование на инциденты" }
description: { en: "Restores a broken node, tool or integration first, then finds the root cause with evidence.", ru: "Сначала восстанавливает работу узла, инструмента или интеграции, затем находит первопричину с доказательствами." }
kind: procedure
sources: [anthropics/knowledge-work-plugins engineering/skills/incident-response/SKILL.md, wshobson/agents plugins/incident-response/skills/incident-runbook-templates/SKILL.md, obra/superpowers skills/systematic-debugging/SKILL.md]
---
1. **Size it**: who is stopped and since when: one agent, one department, the whole company. Tell your head at once if more than one department is stopped.
2. **Look for a runbook**. If one fits, follow it and note where it was wrong.
3. **Restore**: take the fastest safe step that brings work back: restart, roll back the last change, switch to a spare connector, free disk. Change one thing at a time, or you will not know which one helped.
4. **Tell your head** in one line when it starts and in one line when it ends: what broke, who was affected, what you did.
5. **Find the root cause** once work runs again:
   - Reproduce the failure, or find it in the logs with timestamps.
   - Read the whole error and what changed just before it.
   - Write one hypothesis, test it with the smallest experiment, keep or drop it. Do not stack fixes.
   - After two failed fixes, question the premise: the fault may not be where you are looking.
6. **Fix the cause**, not only the symptom, and add a check that would have caught it. A shared change goes to your head as a change request.

Read-only diagnosis and small fixes need no gates. Never delete logs, data or accounts to make an error go away. Write the timeline as you go; the postmortem needs it.
