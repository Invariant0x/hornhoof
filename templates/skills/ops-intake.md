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
2. Write down who needs it, for which task, by when, and what "working" means for them, such as "the backend engineer can call the payments sandbox API".
3. Check what it touches. Anything that changes a shared node, a tool everyone uses, permissions or money goes through ops-change-request. A new account or a paid plan needs the CEO's approval before any sign-up starts.
4. Give access at the smallest scope that does the job: one department, one product, read before write. Access that crosses departments needs the CEO.
5. Assign each as one whole piece: integrations and tools to the integrations engineer, accounts and subscriptions to the accounts administrator, broken things to the reliability engineer. When nobody knows yet what is wrong, read the database yourself first, then split the diagnosis between two or three members at once, each with one question (one node, one integration, one log). Read-only diagnosis and small fixes need no gates.
6. Collect what they found and check it from the requester's side, fix the cause or give the fix as one task, then send the orchestrator one message: what was wrong, what you did, how to use it. Never put a secret in that message: name the secret store entry instead.

A request that comes back three times becomes a standard setup, not new work each time.
