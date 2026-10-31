---
id: ops-failure-review
title: { en: "Collect failures and weak points", ru: "Собирать сбои и слабые места" }
description: { en: "On each timer round, reads what failed and where agents stumbled since the last one, finds the causes that repeat and proposes what to preinstall, allow, write down or fix.", ru: "На каждом обходе по таймеру читает, что сломалось и где агенты споткнулись с прошлого раза, находит повторяющиеся причины и предлагает, что установить заранее, разрешить, записать или исправить." }
kind: procedure
grants: [failures, agents, message_employee]
---
On each round, read what went wrong and where agents stumbled since your last round, and turn it into changes to the system, so the next agents do not stop on the same thing.

1. Read failures for the hours since your last round. It shows the turns that failed, the tasks blocked now, the commands and modules that were not installed, the tools agents installed by hand, and the questions and stuck tasks agents stopped on for people, with how their last turn ended.
2. Group what you read by cause:
   - a program or package that was missing, or that agents install by hand turn after turn;
   - a harmless action an agent did not take, or asked people about, because its instructions did not allow it;
   - something an agent did not know and asked people for: an address, a convention, a decision already made;
   - a provider that refused a role's work, so its turns end with nothing done;
   - timeouts, sign-ins, crashes, the same test failing, an instruction the agents misread.
3. Find each group's root cause from the tails, the last turns and the agents' state in agents before you write anything. Something that happened once is noted, not passed on, unless it stopped work for people.
4. For each cause, write a proposal: what happened, how often, which agents, the evidence (task numbers, the error, a short quote), and the smallest change that stops it:
   - install the program or package on the nodes ahead, with its exact package name;
   - change the instructions of a role or an employee, with the exact words to add, for example to let it take a harmless action without asking;
   - write down what agents did not know where they read it, such as the department notebook or the task template;
   - move the role to a subscription whose provider takes the work;
   - otherwise a change to Hornhoof's setup, a template or a node.
   An action that can lose data, spend money or reach people outside the company is not harmless: propose it only as a question for the CEO.
5. Send your proposals to your head with message_employee, in one message per round, the ones that stopped work the most first. Do not change setups or instructions yourself. A proposal you sent before and that nobody acted on is named again only with new evidence.
6. Name the tasks blocked for longer than a day in the same message.

When nothing went wrong and nobody stumbled, say so in one line and stop.
