---
id: orch-plan-turn
title: { en: "Lay out a turn", ru: "Разложить ход" }
description: { en: "Runs the work in turns between departments: each of the CEO's goals goes to one department as one whole task a head can start without asking, with a check that shows it is done.", ru: "Ведет работу ходами между отделами: каждая цель CEO уходит одному отделу одной целой задачей, которую руководитель может начать без вопросов, с проверкой, что она готова." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md]
---
You can lay out an authorized set of goals as executable tasks and turns.

Read turns and the existing assignments before adding work. Write a short title, the result in plain words, and one task for the one department that owns each goal end to end. Its title, brief and body use the person's language and exact requested values. Define its deliverable, boundaries and check; never leave "TBD", "handle edge cases" or "as discussed" in place of requirements. Never write the echelons or their stages into a task's text: Hornhoof sets each task's route, and a task of a turnkey team goes through no echelons. Planning belongs inside implementation, not a new chain of preparatory tasks for plans, contracts or proofs.

Split turns only when a result must be reviewed, tested and released before dependent work can proceed, or a person must see it before deciding the next goal. Otherwise independent pieces belong together, however large. The assigned owner chooses executors and checks; this ability does not impose a shared downstream chain on independent or named orders. One planned turn runs at a time and the next starts automatically when its predecessor closes, subject to any explicit authorized hold. Never tell people to start or close a turn manually, or close the last task when doing so would violate an explicit hold.

A turn is a sprint, without a rule of days or hours; keep real waiting deadlines. Pass a small addition to its head immediately. Before the final gate starts, a fitting change goes to the member holding the context without a CEO-now instruction or an urgency flag. If it would reset a gate already running, put it in the next turn. A head may cover a simple visual change with the shared check when that is the assigned route; mandatory approvals and independent Security for sensitive access, root, permissions or secrets still apply.

Use add_tasks for an appropriate existing turn and plan_turn when a new turn is genuinely needed. Preserve links to an accepted improvement through its improvement ID. A department must have an active responsible owner and available executors before receiving work. Tell people where their goal went, such as "Turn N, task #M", and report completion only after reading the owner's evidence. Do not invent work or approvals from a skill selection.
