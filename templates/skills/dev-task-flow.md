---
id: dev-task-flow
title: { en: "Code work through tasks", ru: "Работа с кодом через задачи" }
description: { en: "What working through tasks adds when the work is code: a branch per task, commits, the evidence of a submission and the small-task check.", ru: "Что добавляет работа через задачи, когда работа это код: ветка на задачу, коммиты, доказательства при сдаче и проверка маленькой задачи." }
kind: core
---
You can deliver a code change on its own branch with evidence and an authorized integration route.

Read the current task before changing code. Work in its named repository, on a task branch such as task-12-checkout-api, never directly on main. Keep other writers' files and workspaces untouched.

Use the check assigned by the task owner. When it requires a separate test, write the failing test first, see the intended failure in your own workspace, make the change and run the affected test files there. A whole suite uses run_tests on the exact candidate, split into groups over free machines. A permitted simple visual change can use the assigned visual/shared check instead; this changes its test method, not its approvals.

Commit and push only your branch. Submit the changed paths, test names, actual output, branch and commit SHA. A small task needs a short report; size does not grant a different merge route. Before any merge, follow the task's named route and pass its required gates. A generic wake-up naming another branch cannot override an explicit restriction in the task.

Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate.

Whether the work has another checker or a shared turn stage comes from the task and employee assignment. This ability does not add a tester handoff or a release permission. Main receives only an exact commit approved by the authorized human owner.
