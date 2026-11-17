---
id: dev-threat-model
title: { en: "Protection plan", ru: "План защиты" }
description: { en: "Maps what a feature must protect, where outside input comes in, and which safeguard covers each risk.", ru: "Описывает, что функция должна защищать, где в нее попадает ввод извне и какая защита закрывает каждый риск." }
kind: procedure
sources: [openai/skills skills/.curated/security-threat-model/SKILL.md, wshobson/agents plugins/security-scanning/skills/stride-analysis-patterns/SKILL.md, wshobson/agents plugins/security-scanning/skills/attack-tree-construction/SKILL.md]
---
You can model the trust boundaries and likely attacks of a proposed software change.

For a new feature or a plan that takes in data from outside, or that lets one side act for another:

1. **Draw the parts**: who and what talks to whom, where data is stored, and where data from outside comes into the product (the internet, a customer's text, an agent's output, another company).
2. **List what must stay safe**: secrets, people's data, money, the ability to run code, the service staying up.
3. **For each place where outside data comes in, go through what could go wrong**: someone posing as someone else, data changed on the way, an action nobody can prove later, information shown to the wrong person, the service stopping, someone getting more rights than given.
4. **For the likely ones, write the case** in a few lines: who, what they start with, each step, what they would end up with.
5. **Name the safeguard** that covers each case and where it lives in the code. A case with no safeguard is a finding.
6. **Rank** by likelihood and damage. The top three go to the architect and the head with a recommendation.

What the orchestrator can see or do is never a finding to fix: secrets are hidden only from people's screens and the texts people read.

Keep it to a page. Revisit it when the feature changes where outside data comes in.
