---
id: fin-financial-model
title: { en: "Financial model", ru: "Финансовая модель" }
description: { en: "Builds a driver-based model with a linked profit and loss, balance sheet and cash flow.", ru: "Строит модель на драйверах со связанными отчетом о прибылях и убытках, балансом и движением денег." }
kind: procedure
sources: [anthropics/financial-services plugins/agent-plugins/model-builder/skills/3-statement-model/SKILL.md, wshobson/agents plugins/startup-business-analyst/skills/startup-financial-modeling/SKILL.md]
---
1. **Drivers first**: list the few inputs that move the business: new customers per month, price per plan, conversion, churn, headcount and salaries, AI and cloud cost per customer, other fixed costs. Put them on one inputs sheet, each with its source or the reason for the assumption.
2. **Revenue**: build it from customers and prices month by month, not as a growth percentage on last year.
3. **Costs**: cost to serve per customer, people by hire date, marketing spend tied to the customers it brings, fixed costs.
4. **Three statements**: profit and loss, balance sheet and cash flow, linked so that cash flow explains the change in cash and the balance sheet balances every month. Add a check row that shows zero when it does.
5. **Actuals**: start from the last closed month's real numbers, so the model agrees with the books.
6. **Scenarios**: base, downside and upside made by changing drivers, never by editing results. Show the runway in months for each.
7. **Hygiene**: inputs in one place and one colour, no typed numbers inside formulas, one formula per row across all months, units and currency in every label.

Summarize the conclusion, assumptions that could change it and what would prove them wrong. Keep assumptions separate from actuals. Identify the material figures, source records and tolerance for the independent release check.
