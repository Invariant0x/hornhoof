---
id: ops-failure-review
title: { en: "Collect failures and weak points", ru: "Собирать сбои и слабые места" }
description: { en: "On each timer round, reads what failed and where agents stumbled since the last one, finds the causes that repeat and proposes what to preinstall, allow, write down or fix.", ru: "На каждом обходе по таймеру читает, что сломалось и где агенты споткнулись с прошлого раза, находит повторяющиеся причины и предлагает, что установить заранее, разрешить, записать или исправить." }
kind: procedure
grants: [failures, agents, message_employee, improvements]
---
On each round, turn what went wrong and where agents stumbled since your last round into changes, so the next agents do not stop on the same thing.

1. Read failures for the hours since your last round: failed turns, blocked tasks, missing commands and modules, tools agents installed by hand, and the questions and stuck tasks agents stopped on, with how their last turn ended.
2. Group what you read by cause:
   - a program or package that was missing, or that agents install by hand turn after turn;
   - a harmless action an agent did not take, or asked people about, because its instructions did not allow it;
   - something an agent did not know and asked people for: an address, a convention, a decision already made;
   - a provider that refused a role's work, so its turns end with nothing done;
   - timeouts, sign-ins, crashes, the same test failing, an instruction the agents misread.
3. Find each group's root cause from the tails, the last turns and the agents' state in agents first. Something that happened once is noted, not passed on, unless it stopped work for people.
4. For each cause, find the smallest change that stops it:
   - install the program or package on the nodes ahead, with its exact package name;
   - change a role's or an employee's instructions, with the exact words to add, for example to let it take a harmless action without asking;
   - write down what agents did not know where they read it, such as the department notebook or the task template;
   - move the role to a subscription whose provider takes the work;
   - otherwise a change to Hornhoof's setup, a template or a node.
   An action that can lose data, spend money or reach people outside the company is not harmless: say so in the case, for the CEO to decide.
5. Read improvements, then file each change with propose_improvement, as a short case in the CEO's language and plain words. title: the change in a few words; problem: what is wrong; facts: what you checked, each with its source: a task, a log, a count; guesses: what you did not check; why: what it costs now; change: exactly what to do; gain: what it gives. One already there you found again: pass its id instead of putting it twice. Do not change setups or instructions yourself.
6. Tell your head in one message with message_employee what you put there, the ones that stopped work the most first, and name the tasks blocked for longer than a day.

When nothing went wrong and nobody stumbled, say so in one line and stop.
