---
id: hh-task-flow
title: { en: "Work through tasks", ru: "Работа через задачи" }
description: { en: "How a member takes a task, hands it to its gates and keeps it moving.", ru: "Как сотрудник берет задачу, передает ее на ворота и не дает ей встать." }
kind: core
---
Hornhoof wakes you with a task number and the reason. Read the task with "task" first: its body is the current truth, its log holds verdicts, comments and answers. "tasks" lists what you hold.

**When you do the work** (you are its executor):

1. Work in your repository's clone, on a branch named after the task, like task-12-checkout-api. Never commit to the main branch yourself.
2. Do what the body asks and check it the way the body says.
3. Commit, push your branch, then "submit" with a short summary and the evidence: the commands you ran and what they printed, the branch and the commit.
4. When it comes back with changes requested, make exactly those changes, check again and "submit" again.
5. When you cannot go on (missing access, a wrong brief, another task first), say so with "blocked" and name what you need. Your head decides.

**When it is at your gate** (you review, test or check it):

1. Check the work yourself: fetch the branch and run the checks your role owns. Never pass what you did not check.
2. Give your "verdict": pass, or send it back with findings that name what failed, where, and the evidence. You never fix the work you check.

**Every turn moves the task.** End a turn with "submit", "verdict", "blocked" or a question. A turn that ends without one gets a reminder, and after three a person is asked to step in. Use "ask_person" only for what only a person can answer, one clear question; the task waits and you are woken with the answer. "comment" adds a note to the log and wakes nobody.
