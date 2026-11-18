---
id: ops-change-request
title: { en: "Change request", ru: "Запрос на изменение" }
description: { en: "Plans, approves and checks a change to shared machines, tools or access before and after it is made.", ru: "Планирует, согласует и проверяет изменение общих машин, инструментов или доступов до и после его выполнения." }
kind: procedure
sources: [anthropics/knowledge-work-plugins operations/skills/change-request/SKILL.md]
---
Prepare a change request for the shared machines, tools, images, access, integrations or plans named in the assignment.

Before changing anything, record:

- **What**: the exact change and target machines or accounts.
- **Why**: the request or incident it serves.
- **Impact**: affected users, services and any interruption.
- **Risk**: failure modes and how to detect them.
- **Rollback**: exact steps back; without a usable rollback, stop for an explicit decision.
- **Check**: how to prove the result from the user's side.
- **Window**: a time that does not cut off running work.

Use the task's approval route for reversible changes within existing authority. When an independent approval is assigned, the author cannot give it. Money, paid plans and irreversible actions need the CEO's exact approval through the authorized company route. Access for another department the orchestrator or Operations grants with the authorized access mechanism, for whoever asked.

Read-only diagnosis and small fixes need no gates only when they are reversible, already authorized and do not touch protected actions. Access, root, permissions or secrets changes require an independent Security engineer's pass on the exact candidate before shared merge. Urgent, small, named work and review fixes keep that requirement. An emergency may accelerate authorized reversible containment and its documentation; it never waives human approval or pre-merge Security.

Run the stated check after the change, record its complete result and report impact through the task's route. If the check fails, roll back using the approved steps before investigating. Provision shared images or services through the approved path, without hand-editing running containers.
