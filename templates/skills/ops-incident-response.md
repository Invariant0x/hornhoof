---
id: ops-incident-response
title: { en: "Incident response", ru: "Реагирование на инциденты" }
description: { en: "Restores a broken node, tool or integration first, then finds the root cause with evidence.", ru: "Сначала восстанавливает работу узла, инструмента или интеграции, затем находит первопричину с доказательствами." }
kind: procedure
sources: [anthropics/knowledge-work-plugins engineering/skills/incident-response/SKILL.md, wshobson/agents plugins/incident-response/skills/incident-runbook-templates/SKILL.md, obra/superpowers skills/systematic-debugging/SKILL.md]
---
Restore the node, tool or integration named in the incident assignment, then establish the cause from evidence.

1. Size the impact: who is stopped, since when and what may be lost. Notify the assigned incident owner promptly when impact spreads.
2. Read the relevant runbook and confirm its prerequisites. Note steps that are wrong or unsafe.
3. Take the fastest authorized safe recovery step: restart, roll back, use an approved spare connector or free space under approved cleanup rules. Change one thing at a time and preserve logs, data and accounts.
4. Record the start, actions and recovery with timestamps; report what broke, who was affected and what restored service through the incident's route.
5. Reproduce the failure or locate it in logs. Read the full error and preceding changes. Test one hypothesis with the smallest experiment; keep or discard it. After three failed fixes, question the premise instead of stacking changes.
6. Fix the evidenced cause and add the check that would have caught it. For a shared change, document affected users, risk, approved window, rollback and user-side verification.

Read-only diagnosis and small fixes need no gates only when reversible, within existing authority and outside protected actions. Emergency, small, named work and review fixes never waive required human approval or an independent Security engineer's pass before shared merge for access, root, permissions or secrets changes.

For product test environments, verify pinned runtime fingerprints, service readiness, private mutable state per attempt and recovery after interrupted preparation. Keep immutable prepared artifacts unchanged and usable; a failed preparation must not replace the last good version. Request image or service repairs through approved provisioning, never patch running containers by hand. Product tests receive no host sockets or node credentials.

Return the recovery evidence, cause, remaining risks and timeline for any assigned follow-up. Checks and handoff follow the task's gates, rather than this skill selection.
