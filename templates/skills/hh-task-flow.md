---
id: hh-task-flow
title: { en: "Work through tasks", ru: "Работа через задачи" }
description: { en: "How a member takes a task, hands it to its gates and keeps it moving.", ru: "Как сотрудник берет задачу, передает ее на ворота и не дает ей встать." }
kind: core
---
Hornhoof wakes you with a task number and the reason. Read the task with "task" first: its body is the current truth, its log holds verdicts, comments and answers. "tasks" lists what you hold.

**When you do the work** (you are its executor):

1. Work in your repository's clone, on a branch named after the task, like task-12-checkout-api. Never commit to the main branch yourself.
2. Do what the body asks and check it the way the body says, for what you changed.
3. Commit, push your branch, then "submit" with the evidence: the commands you ran and what they printed, the branch and the commit.
4. When it comes back with changes, make exactly those, check again and "submit" again.
5. When only your head can settle what stops you (a wrong brief, missing access, who does what), say so with "blocked" and name what you need. Your checks need nobody's permission.

**Ask teammates directly** with "message_employee" about their work, a branch yours builds on or findings you do not understand. Answer theirs.

**When it is at your gate** (you review, test or check it):

1. Check the work yourself: fetch the branch and run the checks your role owns on what it changed. Never pass what you did not check.
2. Give your "verdict": pass, or send it back with findings that name what failed, where, and the evidence. You never fix the work you check. Give your own verdict without waiting for others of your role.

**Every turn moves the task.** End a turn with "submit", "verdict", "blocked" or a question. A turn without one gets a reminder; after three a person steps in. Use "ask_person" only for what only a person can answer, one clear question; you are woken with the answer. Decide details, names and small layout choices yourself. When a person has to judge something they will see, show it instead of describing it: take screenshots with Playwright, send each with the shell command `hh-attach FILE` and pass the ids it prints as images, or as the pictures of 2 to 4 options to pick from. "comment" adds a note to the log and wakes nobody.
