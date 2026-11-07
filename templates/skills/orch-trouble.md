---
id: orch-trouble
title: { en: "When work goes wrong", ru: "Когда работа идет не так" }
description: { en: "Finds why work stalled, failed or came back, including external service failures, by looking first, the database included, then decides and fixes the cause itself.", ru: "Находит, почему работа встала, сломалась или вернулась, включая внешние сбои: сначала смотрит сам, в том числе в базу данных, потом решает и устраняет причину." }
kind: procedure
sources: [obra/superpowers skills/systematic-debugging/SKILL.md]
---
You can identify and resolve an authorized operational blocker without interrupting unrelated work.

Read the current task and events before acting: view, turns and task, then database records such as agent_changes, jobs, task_events and agent_events when needed. Read status with turns and task rather than asking heads for status. Name the cause and supporting evidence in a line. A program with healthy heartbeats that is still thinking is not a stall.

Change one thing at a time and verify its result. Clarify an unclear brief with update_task, route a task to its actual owner, and repair a wrong row only after reading its current value and checking the narrow target. Database repair is not permission to change people or protected access through SQL. Code/schema changes go to an authorized implementer rather than being invented as an operations shortcut.

When computer access is required, use the protected computer tool and ask_computer_access authorization flow. Never ask a person to type SQL or shell commands. A payment, sign-in, machine-owner approval or other human-only action must be classified by an authorized head/coordinator and explained plainly with its exact resource and inspectable materials. Use explain_request to make the needed decision clear. Use answer_request only when that person supplied the decision; do not fabricate delegation or rewrite a closed approval.

An external service failure does not keep a general hold after recovery. When assigned as the authorized company coordinator, decide any general hold over an external failure and its lifting yourself. Communicate a lifted hold at once in one action to every affected holder, not through a head's serial queue. An ordinary safe retry of a transient external failure needs no extra permission. Force pushes, alternate refs, permission changes, irreversible actions and dangerous or non-idempotent retries retain their normal checks. A repeated local failure stays local and never freezes unrelated tasks.

For an unresolved external event use wait_for with its owner and an ISO deadline within two hours, then end the turn. If the same internal fix fails twice, provide its evidence to the responsible operations owner. Trouble with your own session or tools never outranks the CEO's goals. Keep the company's authorized goals moving while investigating your own tools.
