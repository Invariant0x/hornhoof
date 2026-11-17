---
id: hh-task-flow
title: { en: "Work through tasks", ru: "Работа через задачи" }
description: { en: "Handles assigned work through the task's named checks and delivery route.", ru: "Ведет свою задачу через указанные в ней проверки до сдачи по назначенному маршруту." }
kind: core
---
You can carry an assigned task from its current brief to a proved submission.

Read "task" first: its body and current log govern the work. Work within the assignment's scope, permissions, checks and merge route. The task's actual gates decide whether another employee must approve a result; having this ability does not add a downstream chain.

1. Do what the body asks and check what changed. On `small: true` work, make the change and its check and report a line; a shared turn review exists only when assigned. Required approvals never disappear because a task is small.
2. Use "submit" with what changed, the exact checked version and the actual output or record proving it. When work returns, address its blocking findings, run the affected checks and submit again. Everything you make, letters, texts, layouts and tables as well as code, goes into the task's repository as files in a commit, so that every version is kept. Logs and other proof of checks are no result: give them in submit or report, attach long ones with `hh-attach`, never commit them, and make no commit only to record proof or a note. Push every commit and every branch you make as soon as it is made, finished or not, so that no work lives only on your machine; pushing merges nothing into the main branch. Hand work in as a document only while your department keeps no repository, where task.echelons says document: attach the files with `hh-attach`, hand them in with "submit" and name no commit.
3. If a missing answer, access boundary or dependency prevents progress, use "blocked" and name its owner and the exact missing condition. Routine checks need no new permission. A missing command, such as `sudo: command not found`, is no reason to install it or to get around the limit: run what you may as your own user, and what needs other rights or another user goes to your head with the task and the command, without secrets. A write that Hornhoof answered with 502, 503 or 504 may have gone through: read whether it did before you repeat it.
4. For an external event, call "wait_for" on the task, name its owner and an ISO deadline within two hours, then end the turn. Completion of "run_tests" or "run_work", a task-bound message or the deadline resumes it. A comment or a message on the task ends your wait too: read it, and call "wait_for" again when what you wait for has not come.

Ask teammates directly with "message_employee" about their findings. Pass files using `hh-attach --task N FILE` and retrieve them with `hh-fetch N NAME`, never pasted into messages. Use "ask_person" only for what a person must decide, with a clear question and attached review materials. Each active turn ends with a submission, verdict, explicit wait, blocker or question; do not create self-wake loops.
