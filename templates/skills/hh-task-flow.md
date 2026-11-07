---
id: hh-task-flow
title: { en: "Work through tasks", ru: "Работа через задачи" }
description: { en: "How a member takes a task, hands it to its gates and keeps it moving.", ru: "Как сотрудник берет задачу, передает ее на ворота и не дает ей встать." }
kind: core
---
For `small: true`, use the fast path: make the change and its check, then submit a line stating the change. Detailed reports, matrices, complexity metrics and duplicate checks belong to the shared turn review and checks. If the work grows, tell the head and take the normal path. The steps below describe ordinary work.

**When you do the work** (you are its executor):

1. Do what the body asks and check it the way the body says, for what you changed.
2. Then "submit" with the evidence: what you did, what the check showed and where the result is.
3. When it comes back with changes, make exactly those, check and "submit" again.
4. When only your head can settle what stops you (a wrong brief, missing access, who does what), say so with "blocked" and name what you need. Your checks need nobody's permission.
5. For an external event (a long run on another machine, a delivery, an answer from outside the company), call "wait_for" on your task, name its owner and an ISO deadline within two hours, then end the turn. Completion of "run_tests" or "run_work" also ends that wait and wakes you. A task comment, a message bound to the task or the deadline resumes work; quiet turns do not count while it waits.

**Ask teammates directly** with "message_employee" about their work or findings you do not understand, and answer theirs. Pass files with `hh-attach --task N FILE`, by name, and get them with `hh-fetch N NAME`; never paste one in text.

**At your gate or in the review of a turn** (you review, test or check it):

1. Check the work yourself: run the checks your role owns on what it changed. Never pass what you did not check, and never fix it.
2. Give your own "verdict"; reviewers of other models check at once. Send it back only for what blocks (a check that fails, an unmet requirement, a security hole, data loss), all at once with where and the evidence; the rest are notes under a pass. At a gate of one task, a second round asks you only if you sent it back; the review of a turn has none.

**How hard you think is set when a turn starts.** Plans, first looks, security checks and work run at your role's level, or at the level a person set on your card. A second look at the fixes for your own finding, merging what passed its gates and fixes all your reviewers marked as mechanical run at medium, or at the nearest level above it your model has, and never above your own level. A new level comes with your next turn, never inside this one.

**Every turn moves the task.** End a turn with "submit", "verdict", "blocked", "wait_for" or a question. A turn without one gets a reminder; after three a person steps in. Use "ask_person" only for what only a person can answer, one clear question. Decide details yourself. When a person judges something they will see, show it: send screenshots with `hh-attach FILE` and pass the ids it prints as images, or as pictures of 2 to 4 options. "comment" adds a note to the log; another author commenting on an external wait resumes its holder.
