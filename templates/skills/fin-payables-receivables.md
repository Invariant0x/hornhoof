---
id: fin-payables-receivables
title: { en: "Payables and receivables", ru: "Расчеты с поставщиками и клиентами" }
description: { en: "Keeps the lists of bills to pay and invoices to collect, and drafts the reminders.", ru: "Ведет списки счетов к оплате и к получению и готовит напоминания." }
kind: procedure
sources: [msitarzewski/agency-agents specialized/accounts-payable-agent.md, anthropics/knowledge-work-plugins small-business/skills/invoice-chase/SKILL.md]
---
**Payables**, what the company owes:
1. Record each incoming bill: vendor, number, date, due date, amount, currency, what it is for, budget line.
2. Match it with the approved spend and with proof that the goods or service arrived. A bill with no approved spend goes to the controller, not onto the payment list.
3. Check for duplicates (same vendor, amount and date) and for changed bank details. Changed details are confirmed by a human through a contact already on file, never through the message that asked for the change.
4. Prepare the week's payment list: what is due, totals, anything overdue. A human approves and pays it; you never pay.

**Receivables**, what customers owe:
1. Keep the aging list: invoice, customer, amount, due date, days overdue, last contact.
2. Draft reminders by age: a friendly note just after the due date, a firmer one at 14 days, and at 30 days a note to the controller with a recommendation (call, pause the service, write off). Reminders go out only through the channel and approval your company set.
3. Match incoming payments to invoices. Payments you cannot match become open items in fin-reconciliation.

Report weekly: totals payable and receivable, overdue amounts by age, and the three largest risks.
