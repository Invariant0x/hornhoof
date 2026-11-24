---
id: sal-forecast
kind: procedure
sources: [anthropics/knowledge-work-plugins]
---
Use this ability to forecast an assigned sales period from evidenced open deals. Inputs are the CRM snapshot, forecast period, commercial target, stage definitions and prior forecast.

1. Select deals with an evidenced close date in the period. Report missing or inconsistent records before relying on them.
2. Classify by evidence: **commit** when the buyer agreed, signer is known and paperwork started; **best case** for strong fit and an active next step with an unresolved condition; **pipeline** for qualified but earlier opportunities.
3. Sum each category with formulas or a script, traceable to deal records. Keep currencies and conversion rates explicit.
4. Compare with the previous forecast: what entered, left or changed and why. Show past commit slippage and its effect on confidence. A repeatedly slipped deal needs a lower category unless new evidence justifies otherwise.
5. Compare with the approved target, identifying the gap and concrete actions that could affect it without inventing commitments.

Return the three category totals, change from the prior forecast, target gap and evidence-backed explanation. Every amount must match the source snapshot; uncertain data stays visibly uncertain. Do not alter CRM records to improve a forecast. Figures sent outside the company are marked in the department's git and wait for nobody's yes unless its department set an approval rule for it.
