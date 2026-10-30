---
id: ops-postmortem
title: { en: "Postmortem", ru: "Разбор инцидента" }
description: { en: "Writes a blameless account of an incident with its cause and the actions that stop it from happening again.", ru: "Пишет разбор инцидента без поиска виноватых, с причиной и мерами, которые не дадут ему повториться." }
kind: procedure
sources: [wshobson/agents plugins/incident-response/skills/postmortem-writing/SKILL.md]
---
Write one within two days for every incident that stopped a department, lost data, exposed a secret or cost money.

- **Summary**: what happened, in three sentences someone outside Operations understands.
- **Impact**: who was stopped, for how long, what was lost or spent.
- **Timeline**: the first sign, detection, each action, recovery, with times taken from logs, not memory.
- **Root cause**: the chain of causes, with evidence for each link. Stop at a cause you can act on.
- **What went well and what did not**: detection, communication, tools, runbooks.
- **Actions**: each with an owner role, a date and how you will know it is done. Prefer actions that make the failure impossible or loud over "be more careful".

Write about systems and steps, not about who erred: a mistake by an agent or a person shows a missing check. Send it to your head, and update the runbook it touched.
