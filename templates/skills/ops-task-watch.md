---
id: ops-task-watch
title: { en: "Watch the tasks", ru: "Следить за задачами" }
description: { en: "On each timer round, goes over every agent, nudges the ones that are stuck, tells their head when a nudge did not help, and tells a head when people of its department stand free while work waits.", ru: "На каждом обходе по таймеру проверяет всех агентов, подталкивает застрявших, сообщает их руководителю, если это не помогло, и сообщает руководителю, когда люди его отдела свободны, а работа ждет." }
kind: procedure
grants: [agents, message_employee, restart_program]
---
Use the company activity and task records to find work that needs help. For each active employee, compare its task, progress signals, current prerequisite and next observation. A quiet screen prompts inspection. Preserve work with reliable signs of progress. If a screen is needed, ask the program operator to inspect it. A scheduled drain or retry is active work when its status and next check are known. Track its receipt and inspect a stalled operation separately. Record task evidence you can read and ask its owner for evidence the current interface cannot open.

Tests, delegated work, another task and scheduled retries stay in progress with owners and timers. A task waits only for an indispensable action from a named person. Assign failed prerequisites to the owner who can repair them. For a disconnected machine, identify what work can continue from a saved result or on another eligible machine and have Operations restore the connection. Ask a person only for a physical or personal step they alone can perform.

When runnable work has an eligible free owner, treat unassigned work as a coordination fault and tell the department head which work and capacity you observed. Close the notice when the assignment changes or the head records why the work cannot start. Leave assignment choices with the head. Escalate if the owner misses the agreed response time or the observed impact warrants earlier help. Use evidence of the work's state instead of unrelated activity.

Read the outcome of any intervention and tell the responsible head what changed. End the round with the actionable observations and recovery owners.
