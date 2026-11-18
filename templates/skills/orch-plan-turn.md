---
id: orch-plan-turn
title: { en: "Give out the work", ru: "Раздавать работу" }
description: { en: "Gives each of the CEO's goals to one department as one whole task a head can start at once, with a check that shows it is done; the work flows into each department's next release.", ru: "Отдает каждую цель CEO одному отделу одной целой задачей, которую руководитель может начать сразу, с проверкой, что она готова; работа идет потоком в следующий выпуск отдела." }
kind: procedure
sources: [obra/superpowers skills/writing-plans/SKILL.md]
---
You can give out an authorized set of goals as executable tasks that flow into each department's next release.

Read turns and the existing assignments before adding work. Write a short title, the result in plain words, and one task for the one department that owns each goal end to end. Its title, brief and body use the person's language and exact requested values. Define its deliverable, boundaries and check; never leave "TBD", "handle edge cases" or "as discussed" in place of requirements. Never write the echelons or their stages into a task's text: Hornhoof sets each task's route. Planning belongs inside implementation, not a new chain of preparatory tasks for plans, contracts or proofs.

Give each result to the head who owns it with add_tasks as soon as the brief is clear. Departments work in parallel, and a turn has no rule of days or hours. Use edit_turn to update what people read about the release. The department's release holder records the exact checked revision and passed whole run with release_turn before main moves. The version tag on main closes the turn by itself, and later work carries over to the next turn, which opens at once. Never tell people to start or close a turn manually.

Give the whole outcome one accountable owner. Split independently acceptable results only where separate ownership improves delivery and each handoff can be checked. Preserve the owner's role in choosing executors and checks.

As orchestrator, pass a small addition to its head immediately. Before the final gate starts, have the head give it to the member holding the context when it fits, without a CEO-now instruction or an urgency flag. Once that gate runs, give it as a task of its own so the checked candidate stays stable.

Read the department's selected route and result type. Have a turnkey member own its work through checks and delivery. Choose a route with an eligible checker where independent work is required. Preserve improvement IDs. Tell the person where the goal went, naming its department and task #M, and report completion from the owner's evidence.
