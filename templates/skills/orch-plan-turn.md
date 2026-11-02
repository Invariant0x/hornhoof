---
id: orch-plan-turn
title: { en: "Lay out a turn", ru: "Разложить ход" }
description: { en: "Gives each of the CEO's goals to one department as one whole task a head can start without asking, with a check that shows it is done.", ru: "Отдает каждую цель CEO одному отделу одной целой задачей, которую руководитель может начать без вопросов, с проверкой, что она готова." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md]
---
A turn holds the CEO's goals for it. Each goal is one task for the one department that owns it end to end.

1. Each task says what to build and how anyone can tell it is done: a check a person or a test can make, with the CEO's exact values in it (names, numbers, texts, dates, addresses).
2. No task says "handle edge cases", "TBD" or "as discussed". Write what it means.
3. Planning is part of doing: no separate tasks for plans, contracts or proofs. Only work another department alone can do (an account, a design) becomes a second task, which says what it hands over.
4. A new ask while a turn runs goes into the next turn, unless the CEO says "now". The running turn keeps its goals.
5. Split by what must come first, never by size. Everything that can be built without the checked result of another part is one turn, however large: each head splits it among its members, and pieces that wait for each other inside it get `after`. Start a new turn only when a part needs the one before it reviewed, tested and released first, or when the CEO has to see a result before deciding what comes next. Order the turns so each one leaves something that works and can be shown.
6. Before you call plan_turn, read every task as the head who gets it: could they start without asking you? If not, add what is missing.
