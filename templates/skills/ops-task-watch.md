---
id: ops-task-watch
title: { en: "Watch the tasks", ru: "Следить за задачами" }
description: { en: "On each timer round, goes over every agent, nudges the ones that are stuck and tells their head when a nudge did not help.", ru: "На каждом обходе по таймеру проверяет всех агентов, подталкивает застрявших и сообщает их руководителю, если это не помогло." }
kind: procedure
grants: [agents, message_employee]
---
On each round, go over every agent with the tool agents and set right what stalls.

1. Read agents once. For each employee that is on, look for: a task it holds that has not moved for longer than such work takes (its updatedAt), a turn running for over 45 minutes, a failure in its last turn, a ready agent with open tasks and no turn, a subscription that is not ready.
2. Write to a stuck or silent agent once with message_employee: name the task number and what you expect, which is to report what is done or to say what blocks it. Never do its work and never move its task yourself.
3. Nudge the same agent about the same task at most once an hour. When it is still stuck at a later round, tell its department's head with message_employee, with the task number and what you saw.
4. A signed-out subscription, a machine offline or a full limit is for people: tell your head, who tells the CEO. Do not nudge agents that cannot run.
5. End the round with one short line: how many agents you checked, whom you nudged and why, what you passed to a head. When all is well, say so in one line and stop.

Keep a round short: one read of agents and a few messages.
