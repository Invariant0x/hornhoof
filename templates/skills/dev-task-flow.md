---
id: dev-task-flow
title: { en: "Code work through tasks", ru: "Работа с кодом через задачи" }
description: { en: "What working through tasks adds when the work is code: a branch per task, commits, the evidence of a submission and the small-task check.", ru: "Что добавляет работа через задачи, когда работа это код: ветка на задачу, коммиты, доказательства при сдаче и проверка маленькой задачи." }
kind: core
---
How hh-task-flow goes when the work is code. Before any merge, follow the task's merge route and pass its required gates.

- **A branch per task.** Work in your repository's clone, on a branch named after the task, like task-12-checkout-api. Never commit to the main branch.
- **Submit.** Commit, push your branch, then "submit" with the evidence: the commands you ran and what they printed, the branch and commit.
- **Small code tasks.** Use the check assigned by the head under the shared small-task rule. When it requires a separate test, write a failing test, make the change and run only affected tests. Then merge into the turn's branch; the line you submit names the commit SHA.
