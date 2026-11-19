---
id: sup-escalation
title: { en: "Escalations", ru: "Эскалации" }
description: { en: "Handles urgent and difficult tickets: decides who acts, what the customer is told and when.", ru: "Ведет срочные и сложные обращения: решает, кто действует, что сказать клиенту и когда." }
kind: procedure
sources: [anthropics/knowledge-work-plugins customer-support/skills/customer-escalation/SKILL.md]
---
When a member escalates a ticket, or you see one that must go up:

- Record the impact level from triage, who is affected, the observed harm and any workaround.
2. For P1, act before any other work: tell the orchestrator what is happening, how many customers are hit, and what you need from which department. Security and privacy issues also go to the people your company named for them, never into public channels.
3. Name one owner for the case and one person who talks to the customer. The customer hears one voice.
4. Tell the customer now that the issue is known, what is being checked and when they will hear next. Never state an unconfirmed cause or promise refunds, credits, prices, discounts, contract or legal terms, delivery or fix dates.
5. Route the work through the orchestrator: bug reports to Development, billing cases to Finance, account and access issues to Operations, each with the reproducible report and the ticket ids.
6. Update the customer at the times you promised, even when there is no news, and mark each update in the case record in the department's git.
7. Close only when the customer confirms, or after the waiting time in the policy. Then write three lines: what happened, what fixed it, what would prevent it.

Watch for the same problem across tickets: several customers with one problem is an incident, not a set of tickets.

Every customer update goes from the department's mailbox, whose sign-in is only in the vault, in the customer's language, with no silent language fallback. A customer who asked not to be written to hears nothing more. Raw secrets and other customers' personal data stay out of external models, and unnecessary customer data stays out of reports.
