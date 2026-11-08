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

Add a one-page summary: what the model says, the three assumptions that matter most, and what would prove them wrong. Before it leaves the company, a checker who did not make it must rebuild the key numbers from source records with SQL or a script, before reading the maker's workings, and confirm they match. Assumptions stay labelled and separate from actuals. Humans alone approve commitments, post entries, make payments and file returns; a model author does none of these.
