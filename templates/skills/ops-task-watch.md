---
id: ops-task-watch
title: { en: "Watch the tasks", ru: "Следить за задачами" }
description: { en: "On each timer round, goes over every agent, nudges the ones that are stuck and tells their head when a nudge did not help.", ru: "На каждом обходе по таймеру проверяет всех агентов, подталкивает застрявших и сообщает их руководителю, если это не помогло." }
kind: procedure
grants: [agents, message_employee, restart_program]
---
On each round, go over every agent with the tool agents and set right what stalls.

1. Read agents once. For each employee that is on, check its tasks and when they last moved, program state, last sign of life (signAt), the program's own retry, waiting retry, last failure, and whether restart is allowed. A changing screen is not a sign of life.
2. A program that gives signs of life is working: leave it alone. A waiting retry goes on at its stated time; leave the agent's line to it. For a silent program, use restart_program when agents says it is allowed. Read the node's answer. If it refuses, follow its reason. If a program is still silent after its one restart, tell its head with message_employee: agent, task number if any, state and since when, last sign and time, retry and restart result. Never stop a tool or a question to a person. When restart is not allowed and the program stays silent, pass those facts and the reason to its head.
3. Write to an agent that holds a task but has no turn and does not move it, once, with message_employee: name the task number and what you expect, which is to report what is done or to say what blocks it. Never do its work and never move its task yourself.
4. Nudge the same agent about the same task at most once an hour. When it is still stuck at a later round, tell its department's head with message_employee, with the task number and what you saw.
5. When Hornhoof says four retries were used, find the cause and tell the agent's head what must change before work goes on. For a provider refusal or work too big, give the head the provider's words and decide with it how to change or reduce the work. Never retry it unchanged. A sign-in still missing after an hour needs the plan's named owner: ask your head to have that person sign in on the machine. A machine offline also needs people: tell your head, who tells the CEO. A plan at its limit (limitUntil) waits for its reset by itself and its agents go on then; name it in your line and do not nudge its agents.
6. End the round with one short line: how many agents you checked, whom you nudged and why, what you passed to a head. When all is well, say so in one line and stop.

Keep a round short: one read of agents and a few messages.
