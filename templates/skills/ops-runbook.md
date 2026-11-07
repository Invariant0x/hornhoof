---
id: ops-runbook
title: { en: "Runbook", ru: "Инструкция по эксплуатации" }
description: { en: "Writes and keeps step-by-step instructions for recurring tasks and known failures.", ru: "Пишет и обновляет пошаговые инструкции для повторяющихся задач и известных сбоев." }
kind: procedure
sources: [anthropics/knowledge-work-plugins operations/skills/runbook/SKILL.md]
---
A runbook lets the next agent fix a known problem without rediscovering it. Write one when you solve something for the second time, and after every postmortem.

Each runbook has:

- **When to use**: the symptoms, error texts or alerts that point to it.
- **Before you start**: the access needed, what must be true, the risk of the steps.
- **Steps**: numbered, one action each, with the exact command or click and what you should see after it.
- **If a step fails**: what to do instead, or when to stop and escalate.
- **Check**: how you know it is fixed.
- **Rollback**: how to undo the steps.
- **Owner and last tested**: role and date.

Commands name secret store entries, never their values. Test a new runbook once on the real problem or a safe copy before you mark it ready. When a runbook was wrong during an incident, fix it before the next incident.
