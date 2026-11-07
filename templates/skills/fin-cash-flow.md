---
id: fin-cash-flow
title: { en: "Cash position", ru: "Денежная позиция" }
description: { en: "Shows the cash the company has, what comes in and goes out in the next weeks, and the runway.", ru: "Показывает, сколько у компании денег, что придет и уйдет в ближайшие недели и на сколько их хватит." }
kind: procedure
sources: [anthropics/knowledge-work-plugins small-business/skills/cash-flow-snapshot/SKILL.md]
---
Every week:

1. **Cash today**: the balance of each bank and payment account, taken from statements, with the date. Total in the company's main currency at a stated rate.
2. **Next 13 weeks**, week by week:
   - In: expected customer payments (from receivables and subscriptions, with a realistic delay for late payers) and other income.
   - Out: payroll, rent, subscriptions, AI and cloud usage, contractors, taxes, loan payments, approved one-off spend.
3. **Closing cash** for each week. Mark any week where it falls below the minimum the CEO set.
4. **Burn and runway**: average net monthly outflow over the last three months, and the months of cash left at that rate.
5. **Changes** since last week's view, and why (a late customer, a new subscription).
6. **Actions** if cash is tight: collect named overdue invoices, delay named payments, cut named spend, each with its amount. The controller and the CEO decide.

Keep it to one table and five lines of text. Use real balances and dated sources, not the model's assumptions. Before cash figures leave the company, a checker who did not make them rebuilds the key numbers from source records with SQL or a script and confirms they match. Actions remain recommendations: humans decide commitments, move money, post entries and file returns, never the agent preparing this view.
