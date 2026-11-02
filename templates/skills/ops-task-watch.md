---
id: ops-task-watch
title: { en: "Watch the tasks", ru: "Следить за задачами" }
description: { en: "On each timer round, goes over every agent, nudges the ones that are stuck and tells their head when a nudge did not help.", ru: "На каждом обходе по таймеру проверяет всех агентов, подталкивает застрявших и сообщает их руководителю, если это не помогло." }
kind: procedure
grants: [agents, message_employee]
---
On each round, go over every agent with the tool agents and set right what stalls.

1. Read agents once. For each employee that is on, look for: a task it holds that has not moved for longer than such work takes (its updatedAt), a running turn with no sign of life for 30 minutes (busy, and its lastActivityAt that long ago), a failure in its last turn, a ready agent with open tasks and no turn, a subscription that is not ready.
2. A long turn that still shows activity is work going on: leave it alone, however long it runs. A turn silent for 30 minutes may hang, and the work behind it waits: tell its department's head with message_employee, with the agent, the task number and since when it is silent. The head tells the CEO, who decides whether to stop it.
3. Write to an agent that holds a task but has no turn and does not move it, once, with message_employee: name the task number and what you expect, which is to report what is done or to say what blocks it. Never do its work and never move its task yourself.
4. Nudge the same agent about the same task at most once an hour. When it is still stuck at a later round, tell its department's head with message_employee, with the task number and what you saw.
5. A signed-out subscription or a machine offline is for people: tell your head, who tells the CEO. A plan at its limit (limitUntil) waits for its reset by itself and its agents go on then; name it in your line and do not nudge its agents.
6. End the round with one short line: how many agents you checked, whom you nudged and why, what you passed to a head. When all is well, say so in one line and stop.

Keep a round short: one read of agents and a few messages.
