---
id: fin-close-management
title: { en: "Month-end close", ru: "Закрытие месяца" }
description: { en: "Runs the monthly close as a checklist, from cut-off to statements the CEO can trust.", ru: "Проводит закрытие месяца по чек-листу, от отсечки до отчетности, которой может доверять CEO." }
kind: procedure
sources: [anthropics/knowledge-work-plugins finance/skills/close-management/SKILL.md, anthropics/financial-services plugins/agent-plugins/month-end-closer/agents/month-end-closer.md]
---
Run the close on a fixed calendar with one checklist, so every month is done the same way.

1. **Cut-off** (day 1): no new entries for the closed month except closing ones. Collect bank, card and payment processor statements, payroll, invoices issued and received.
2. **Assign** (day 1): each task to a maker (usually the bookkeeper) and a different checker (the finance auditor or a human), with a due day.
3. **Reconcile** (days 2-3): every bank, card and processor account, receivables, payables and other balance accounts, with fin-reconciliation. Unexplained differences stay open items; never plug them.
4. **Accrue and adjust** (days 3-4): accruals, prepaid expenses, deferred revenue, depreciation, with fin-accruals and fin-journal-entries.
5. **Review** (day 4): the trial balance, then fin-variance-analysis against last month and the budget. Investigate anything unusual before going on.
6. **Statements** (day 5): profit and loss, balance sheet and cash flow, with a one-page commentary. The balance sheet balances and cash agrees with the bank.
7. **Check** (day 5): the finance auditor recomputes the key numbers independently; statements leave finance only after it passes them.
8. **Post and lock**: humans post the approved entries and lock the period.

Keep a close log: task, maker, checker, status, open items. Report a late close the day it slips. After each close, note what took longest and improve the checklist.
