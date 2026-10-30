---
id: dev-threat-model
title: { en: "Threat model", ru: "Модель угроз" }
description: { en: "Maps who could attack a feature, how, and which defences stop them.", ru: "Описывает, кто может атаковать функцию, как и какие защиты это остановят." }
kind: procedure
sources: [openai/skills skills/.curated/security-threat-model/SKILL.md, wshobson/agents plugins/security-scanning/skills/stride-analysis-patterns/SKILL.md, wshobson/agents plugins/security-scanning/skills/attack-tree-construction/SKILL.md]
---
For a new feature or a plan that crosses a trust boundary:

1. **Draw the parts**: who and what talks to whom, where data is stored, where it crosses from untrusted to trusted (the internet, a customer's text, an agent's output, another company).
2. **List what is worth stealing or breaking**: secrets, other people's data, money, the ability to run code, availability.
3. **For each boundary, walk the threats**: spoofing someone, tampering with data, denying an action, leaking information, stopping the service, gaining more rights.
4. **For the likely ones, write the attack** as a short path: the attacker, what they start with, each step, what they get.
5. **Name the defence** that stops each path and where it lives in the code. A path with no defence is a finding.
6. **Rank** by likelihood and damage. The top three go to the architect and the head with a recommendation.

Keep it to a page. Revisit it when the feature changes its boundaries.
