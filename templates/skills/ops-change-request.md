---
id: ops-change-request
title: { en: "Change request", ru: "Запрос на изменение" }
description: { en: "Plans, approves and checks a change to shared machines, tools or access before and after it is made.", ru: "Планирует, согласует и проверяет изменение общих машин, инструментов или доступов до и после его выполнения." }
kind: procedure
sources: [anthropics/knowledge-work-plugins operations/skills/change-request/SKILL.md]
---
Use this for any change other people depend on: a node's setup, a tool or image every agent uses, permissions, a shared integration, a paid plan.

Write the request before the change:

- **What**: the exact change, on which machines or accounts.
- **Why**: the request or incident it serves.
- **Impact**: who and what it affects, and whether work stops while it runs.
- **Risk**: what can go wrong and how you would notice.
- **Rollback**: the exact steps back. No rollback means the change waits until there is one.
- **Check**: how you prove it worked, from the user's side.
- **Window**: when it runs, chosen so that no running task is cut off.

Approval:

1. Low risk, reversible, inside Operations: you approve it, and the member who wrote the request is not the one who approves it.
2. Anything that costs money, changes access for other departments or cannot be rolled back: ask the CEO through the orchestrator, with the request above.
3. An emergency fix during an incident may run first, but its request is written the same day.

After the change, run the check, record the result next to the request, and tell the departments affected through the orchestrator. A failed check means rollback first, investigation second.
