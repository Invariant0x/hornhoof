---
id: hh-task-flow
title: { en: "Work through tasks", ru: "Работа через задачи" }
description: { en: "How a member takes a task, hands it to its gates and keeps it moving.", ru: "Как сотрудник берет задачу, передает ее на ворота и не дает ей встать." }
kind: core
---
You can carry an assigned task from its current brief to a proved submission.

Read "task" first: its body and current log govern the work. Work within the assignment's scope, permissions, check and merge route. The task's actual gates decide whether another employee must approve a result; having this ability does not add a downstream chain.

1. Do what the body asks and check what changed. On `small: true` work, make the change and its check and report a line; a shared turn review exists only when assigned. Required approvals never disappear because a task is small.
2. Use "submit" with what changed, the exact checked version and the actual output or record proving it. When work returns, address its blocking findings, run the affected checks and submit again.
3. If a missing answer, access boundary or dependency prevents progress, use "blocked" and name its owner and the exact missing condition. Routine checks need no new permission.
4. For an external event, call "wait_for" on the task, name its owner and an ISO deadline within two hours, then end the turn. Completion of "run_tests" or "run_work", a task-bound message or the deadline resumes it.

Ask teammates directly with "message_employee" about their findings. Pass files using `hh-attach --task N FILE` and retrieve them with `hh-fetch N NAME`, never pasted into messages. Use "ask_person" only for what a person must decide, with a clear question and attached review materials. Each active turn ends with a submission, verdict, explicit wait, blocker or question; do not create self-wake loops.
