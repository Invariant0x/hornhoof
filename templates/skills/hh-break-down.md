---
id: hh-break-down
title: { en: "Break work down", ru: "Разбить работу на задачи" }
description: { en: "Splits a goal into large pieces with independent parts started at once so the department stays loaded, each with an owner and a check.", ru: "Делит цель на крупные части и сразу выделяет независимые части, чтобы отдел оставался загруженным, у каждой есть исполнитель и проверка." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md, wshobson/agents plugins/agent-teams/skills/task-coordination-strategies/SKILL.md, addyosmani/agent-skills skills/planning-and-task-breakdown/SKILL.md]
---
For `small: true`, use the fast path in hh-lead-tasks: assign directly without splitting or separate gates. Detailed planning and reports belong to the shared turn review. The decomposition below is for other work.

When a goal reaches your department, whoever gives out the work answers for keeping the department loaded, not only for ordering tasks. Members standing free while work in the department can run are a fault, not a normal wait:

1. Restate the goal and what "done" means in one or two sentences a person could check. If you cannot, ask before you give anything out.
2. Split it into two to four large self-contained pieces for different members to do at once, each a whole result one member owns end to end, with one check that shows it is done; pieces that touch the same files or records go to one member. A small goal is one piece. Each piece is a whole result, not a step of preparation: planning is part of doing, so no tasks for plans, contracts or proofs before the real work. The one exception is a short step your department's rules name for a new or large piece, such as an architect's design note: give it at the same time, with the piece waiting on it in `after`.
3. When two pieces must fit together, their owners agree how they fit directly, in the task's comments or by message, and both start at once: no separate task for that.
4. For each piece write: the owner, what it receives, what it hands back and how the result is checked; never assign non-urgent work to an urgent-only team (`urgentOnly`), as Hornhoof refuses the assignment and names free members in the same role. A piece that truly needs another's result names that task in `after` and passes either `independentPart` (`{ title, brief, body, executor }`, started at once for a free member while the parent waits) or `independentNone` naming single file ownership, genuine dependencies or release boundaries; pass neither when `after` is empty, and start all other pieces at once.
5. Give each piece only the gates it needs: none for research, reports, plans and docs, nor for code in a repository, which the review of the turn checks at once; one review for other normal work; more only where your department's rules ask for them. The one who did the work never passes its own gate.
6. A new ask that comes while the work runs goes to the next turn, unless the CEO says "now".

Show the plan to whoever gave you the goal only when it changes scope, cost or dates; otherwise start.
