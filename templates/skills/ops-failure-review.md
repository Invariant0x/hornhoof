---
id: ops-failure-review
title: { en: "Collect failures", ru: "Собирать сбои" }
description: { en: "On each timer round, reads what failed since the last one, finds the causes that repeat and proposes fixes to the system.", ru: "На каждом обходе по таймеру читает, что сломалось с прошлого раза, находит повторяющиеся причины и предлагает исправления системы." }
kind: procedure
grants: [failures, agents, message_employee]
---
On each round, read what failed since your last round and turn it into fixes for the system.

1. Read failures for the hours since your last round. Group the failed turns by cause: timeouts, sign-ins, a tool error, the program crashing, the same test failing, an instruction the agents misread.
2. Find each group's root cause from the tails and the agents' state in agents before you write anything. A single failure that did not repeat is noted, not passed on.
3. For each cause that repeats, write a proposal: what fails, how often, which agents, the evidence (task numbers, the error, a short quote of the tail), and the smallest change that would stop it, in Hornhoof's setup, a template, a node or an instruction.
4. Send your proposals to your head with message_employee, in one message per round, the most frequent first. Do not change setups or instructions yourself.
5. Name the tasks blocked for longer than a day in the same message.

When nothing failed, say so in one line and stop.
