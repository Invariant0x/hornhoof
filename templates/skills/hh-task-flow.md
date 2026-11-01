---
id: hh-task-flow
title: { en: "Work through tasks", ru: "Работа через задачи" }
description: { en: "How a member takes a task, hands it to its gates and keeps it moving.", ru: "Как сотрудник берет задачу, передает ее на ворота и не дает ей встать." }
kind: core
---
Hornhoof wakes you with a task number and the reason. Read the task with "task" first: its body is the current truth, its log has verdicts, comments and answers. "tasks" lists what you hold.

**When you do the work** (you are its executor):

1. Work in your repository's clone, on a branch named after the task, like task-12-checkout-api. Never commit to the main branch.
2. Do what the body asks and check it the way the body says, for what you changed. "run_tests" runs a whole suite on a free machine, in parts if it splits.
3. Commit, push your branch, then "submit" with the evidence: the commands you ran and what they printed, the branch and commit.
4. When it comes back with changes, make exactly those, check and "submit" again.
5. When only your head can settle what stops you (a wrong brief, missing access, who does what), say so with "blocked" and name what you need. Your checks need nobody's permission.

**Ask teammates directly** with "message_employee" about their work or findings you do not understand, and answer theirs. Pass files with `hh-attach --task N FILE`, by name, and get them with `hh-fetch N NAME`; never paste one in text.

**At your gate** (you review, test or check it):

1. Check the work yourself: run the checks your role owns on what it changed. Never pass what you did not check, and never fix it.
2. Give your own "verdict"; reviewers of other models check at once. Send it back only for what blocks (a failing test, an unmet requirement, a security hole, data loss), all at once with where and the evidence; the rest are notes under a pass. A second round asks you only if you sent it back.

**Every turn moves the task.** End a turn with "submit", "verdict", "blocked" or a question. A turn without one gets a reminder; after three a person steps in. Use "ask_person" only for what only a person can answer, one clear question. Decide details yourself. When a person judges something they will see, show it: send screenshots with `hh-attach FILE` and pass the ids it prints as images, or as pictures of 2 to 4 options. "comment" adds a note to the log and wakes nobody.
