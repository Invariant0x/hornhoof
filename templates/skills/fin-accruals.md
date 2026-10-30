---
id: fin-accruals
title: { en: "Accruals and rollforwards", ru: "Начисления и движение остатков" }
description: { en: "Calculates month-end accruals, prepaid and deferred amounts, and shows how each balance moved.", ru: "Рассчитывает начисления, расходы будущих периодов и отложенную выручку на конец месяца и показывает движение каждого остатка." }
kind: procedure
sources: [anthropics/financial-services plugins/agent-plugins/month-end-closer]
---
At month end, for each balance sheet account that holds estimates:

1. **Accrued expenses**: services received but not yet invoiced (contractors, cloud and AI usage, utilities, payroll days). Base each on a usage report, a contract or the last three invoices, and write the method down.
2. **Prepaid expenses**: payments for future months (annual subscriptions, insurance). Spread them over the months they cover and release this month's part.
3. **Deferred revenue**: customers who paid ahead. Recognise the part for service delivered this month; the rest stays deferred.
4. **Depreciation and amortisation**: from the asset list and the company's policy.
5. **Rollforward** per account: opening balance + additions - releases or payments +/- adjustments = closing balance. The closing balance must tie to the trial balance.
6. When the real invoice arrives, reverse last month's accrual and note the difference between estimate and invoice. Large differences mean the method needs fixing.

Draft the entries with fin-journal-entries. Keep one schedule per account with its inputs, so the checker can recompute it without asking you. Label estimates as estimates.
