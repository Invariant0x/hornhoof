---
id: fin-spend-approval
title: { en: "Spend approval", ru: "Согласование расходов" }
description: { en: "Gate for every spend: checks the request against budget and policy before a human approves and pays.", ru: "Шлюз для каждого расхода: проверяет запрос по бюджету и правилам, прежде чем человек утвердит и оплатит." }
kind: gate
sources: []
---
No money is spent without this gate: purchases, subscriptions, contractors, ads, refunds above the support limit, AI usage above budget. Agents never pay; the gate prepares the decision for the human who does.

For each request, check:
1. **Request**: who asks, what for, amount and currency, one-off or recurring (with the yearly total), vendor, when it is needed.
2. **Budget**: which budget line it hits, what is left on it this month, and the total after this spend. Over budget goes to the CEO.
3. **Need**: the business reason in one sentence, what happens if it is not bought, and cheaper options considered.
4. **Policy**: within the approval limit your company set for that person or department; the vendor is real and known (check name, site and bank details against earlier invoices; changed bank details are a red flag); no purchase split to stay under a limit.
5. **Terms**: contract length, auto-renewal, cancellation, what data the vendor gets. Long or unusual terms go to the CEO.
6. **Separation**: the requester does not approve their own spend, and the approver does not also pay.

Verdict: approve for payment (name the human who pays), approve with changes, refuse (with the reason), or escalate to the CEO. Record every verdict in the spend log with date, amount and approver. Report any spend that skipped this gate to the CEO, however small.
