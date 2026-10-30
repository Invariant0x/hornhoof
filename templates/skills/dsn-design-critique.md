---
id: dsn-design-critique
title: { en: "Design critique", ru: "Разбор дизайна" }
description: { en: "Reviews a design against its goal and the system, and gives findings a designer can act on.", ru: "Оценивает макет относительно его цели и дизайн-системы и дает замечания, по которым дизайнер может действовать." }
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/design-critique/SKILL.md]
---
Review a design before it goes to development, and whenever a designer asks.

1. Read the brief first: who uses this screen, what they must get done, what success looks like. Judge against that, not against taste.
2. Walk the main task as the user, step by step. Note where you hesitate, what you read twice, where the next action is unclear.
3. Check the structure: one clear primary action per screen, a hierarchy you see at a glance, related things grouped, nothing important lost in noise.
4. Check the states: empty, loading, error, partial data, long text, long Russian text, a narrow phone screen.
5. Check the system: tokens and components used as defined, no one-off colours, sizes or controls.
6. Write findings, most important first. Each says what you saw, why it hurts the user's task, and a direction for the fix. Mark each as must fix, should fix or suggestion.
7. Say what works too, so it survives the next round.

Keep to the findings that change the result. Thirty small notes hide the three that matter.
