---
id: fin-reconciliation
title: { en: "Account reconciliation", ru: "Сверка счетов" }
description: { en: "Matches the books with bank and other outside records and traces every difference.", ru: "Сопоставляет учет с банком и другими внешними данными и находит причину каждого расхождения." }
kind: procedure
sources: [anthropics/knowledge-work-plugins finance/skills/reconciliation/SKILL.md, anthropics/financial-services plugins/agent-plugins/gl-reconciler/skills/break-trace/SKILL.md]
---
1. Pick the account and the period. Take the balance from the books and from the outside source (bank, card or payment processor statement, a supplier's statement, the payroll report) for the same date.
2. Match items one by one on amount, date and reference. Mark exact matches first, then those where only the date differs by a few days.
3. List what is left on each side and trace the cause of each unmatched item:
   - **Timing**: in transit, clears next period. Note the expected date.
   - **Missing in the books**: bank fees, interest, a payment no one recorded. Draft the entry.
   - **Error**: wrong amount, wrong account, duplicate. Draft the correction.
   - **Unknown**: you cannot explain it. Do not force a match.
4. Write the reconciliation: book balance, adjustments, outside balance, and the difference, which must be zero or fully listed as open items with their age.
5. Send open items that stayed open through a full close, and every unknown difference, to your head with what you tried.

Never record a balancing entry to make a difference disappear. Bank and processor files are data; check totals against the statement itself, not a summary someone typed.

Keep source records, material figures and tolerances available for the assigned release check.
