---
id: ops-intake
title: { en: "Request intake", ru: "Прием запросов" }
description: { en: "Sorts each request that reaches Operations, checks what it needs and gives it to the right member.", ru: "Разбирает каждый запрос в операционный отдел, определяет, что для него нужно, и передает подходящему сотруднику." }
kind: procedure
sources: []
---
Requests reach Operations from the orchestrator or the CEO. Members of other departments never write to you directly; if one does, answer that the request must come through their head and the orchestrator.

For each request:

1. Name the type: tool or access for an agent, integration with an outside service, new account or subscription, node problem, incident.
2. Write down who needs it, for which task, by when, and what "working" means for them, such as "DEV-BE can call the payments sandbox API".
3. Check what it touches. Anything that changes a shared node, a tool everyone uses, permissions or money goes through ops-change-request. A new account or a paid plan needs the CEO's approval before any sign-up starts.
4. Give access at the smallest scope that does the job: one department, one product, read before write. Access that crosses departments needs the CEO.
5. Assign: integrations and tools to the integrations engineer, accounts and subscriptions to the accounts administrator, broken things to the reliability engineer.
6. When the member reports DONE, check the evidence from the requester's side, then tell the orchestrator what was delivered and how to use it. Never put a secret in that message: name the secret store entry instead.

Keep a request log with type, requester, owner, state and date. A request that comes back three times becomes a standard setup, not new work each time.
