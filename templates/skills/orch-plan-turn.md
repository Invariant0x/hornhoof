---
id: orch-plan-turn
title: { en: "Lay out a turn", ru: "Разложить ход" }
description: { en: "Runs the work in turns between departments: each of the CEO's goals goes to one department as one whole task a head can start without asking, with a check that shows it is done.", ru: "Ведет работу ходами между отделами: каждая цель CEO уходит одному отделу одной целой задачей, которую руководитель может начать без вопросов, с проверкой, что она готова." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md]
---
Run the work in turns. When people ask for work, lay it out with "plan_turn": a short title, the main point in one or two sentences, and for each of the CEO's goals one task for the one department that owns it end to end, with a title, a one-line brief and a body that says what to build and how to tell it is done. Write titles and briefs in the language the CEO writes in: the CEO reads them in the tracker. Lay out only what people asked for; when an ask is unclear, ask one question first (orch-interview).

1. Each task says how anyone can tell it is done: a check a person or a test can make, with the CEO's exact values in it (names, numbers, texts, dates, addresses). No task says "handle edge cases", "TBD" or "as discussed": write what it means.
2. Planning is part of doing: no separate tasks for plans, contracts or proofs. Only work another department alone can do (an account, a design) becomes a second task, which says what it hands over.
3. A turn holds the goals the CEO gave for it. Split by what must come first, never by size. Everything that can be built without the checked result of another part is one turn, however large: each head splits it among its members, and pieces that wait for each other inside it get `after`. Start a new turn only when a part needs the one before it reviewed, tested and released first, or when the CEO has to see a result before deciding what comes next. Order the turns so each one leaves something that works and can be shown.
4. One turn runs at a time; the next planned one starts by itself when every task of the running one is closed, so never tell people to start or close a turn.
5. When people add to the work, call "turns" and apply the admission rule in hh-lead-tasks. Use "add_tasks" for an existing turn, or "plan_turn" when the work needs a new one. The running turn keeps its goals. Tell people in a line where their ask went, like "Turn N, task #M".
6. Before you call plan_turn, read every task as the head who gets it: could they start without asking you? If not, add what is missing. A department without a head cannot take tasks, and one whose head or employees are all off takes none until it is on: staff it, or tell the CEO instead of planning work for it.
7. The head of a department splits its task among the department and takes it through its gates; Hornhoof wakes you when a department task is done or cannot go on. Never do a department's work yourself, and never say work is done before its head reported it.
