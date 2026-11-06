---
id: sup-ticket-triage
title: { en: "Ticket triage", ru: "Разбор обращений" }
description: { en: "Sorts each new ticket by type, urgency and route, and spots what must go up at once.", ru: "Сортирует каждое новое обращение по типу, срочности и маршруту и замечает то, что нужно сразу передать выше." }
kind: procedure
sources: [anthropics/knowledge-work-plugins customer-support]
---
For each new ticket:

1. Read the whole ticket and the customer's earlier tickets.
2. **Type**: question, how-to, bug, billing, account access, feature request, complaint, security or abuse, spam.
3. **Urgency**:
   - P1: the product is down or data is lost for this customer, a security or privacy issue, a legal threat, money taken wrongly.
   - P2: a main feature is broken with no workaround.
   - P3: a problem with a workaround, or a how-to question.
   - P4: feedback, feature requests, general questions.
4. **Language**: English or Russian; note it for the reply.
5. **Route**:
   - A knowledge base article answers it: draft the reply yourself (sup-deflection, sup-draft-response).
   - Bug, billing, access, or anything that needs a system you cannot read: escalate to your head for second line.
   - P1, security, privacy, legal, press, or a customer about to leave: escalate to your head now, before drafting anything.
   - Spam: mark it and do not reply.
6. Look for duplicates. Several customers reporting the same thing within hours may be an outage; say so in the escalation.

Write one line per ticket: id, type, urgency, language, route, a one-sentence summary. Never change a customer's account, plan or payment data.
