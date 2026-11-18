---
id: ops-failure-review
title: { en: "Collect failures and weak points", ru: "Собирать сбои и слабые места" }
description: { en: "On each timer round, reads what failed and where agents stumbled since the last one, finds the causes that repeat and proposes what to preinstall, allow, write down or fix.", ru: "На каждом обходе по таймеру читает, что сломалось и где агенты споткнулись с прошлого раза, находит повторяющиеся причины и предлагает, что установить заранее, разрешить, записать или исправить." }
kind: procedure
grants: [failures, agents, message_employee, improvements]
---
For the review period named in the assignment, turn failures and recurring weak points into evidence-backed improvement proposals. Use the previous run as the boundary when this is an assigned timer round.

1. Read failures in that period: failed turns, blocked tasks, missing commands and modules, tools agents installed by hand, and the questions and stuck tasks agents stopped on, with how their last turn ended.
2. Group what you read by cause:
   - a program or package that was missing, or that agents install by hand turn after turn;
   - a harmless action an agent did not take, or asked people about, because its instructions did not allow it;
   - something an agent did not know and asked people for: an address, a convention, a decision already made;
   - a provider that refused a role's work, so its turns end with nothing done;
   - timeouts, sign-ins, crashes, the same test failing, an instruction the agents misread.
3. Find each group's root cause from the tails, the reasons Hornhoof recorded, the end of each blocked reason, the last turns and the agents' state in agents first. Something that happened once is noted, not passed on, unless it stopped work for people.
4. For each cause, find the smallest change that stops it:
   - install the program or package on the nodes ahead, with its exact package name;
   - change a role's or an employee's instructions, with the exact words to add, for example to let it take a harmless action without asking;
   - write down what agents did not know where they read it, such as the department notebook or the task template;
   - move the role to a subscription whose provider takes the work;
   - otherwise a change to the working setup, a template or a node.
   An action that can lose data or spend money is not harmless: say so in the case, for the CEO to decide. Writing, posting and talking to people outside the company is the department's own work: a change to how it does that goes to the department's own people. Proposed access, root, permissions or secrets changes retain human approval and an independent Security engineer's pass on the exact candidate before shared merge, including urgent, small, named work and review fixes.
5. Read improvements, then file each change with propose_improvement, as a short case in the CEO's language and plain words. title: the change in a few words; problem: what is wrong; facts: what you checked, each with its source: a task, a log, a count; guesses: what you did not check; why: what it costs now; change: exactly what to do; gain: what it gives. One already there you found again: pass its id instead of putting it twice. Do not change setups or instructions as part of this review; implementation needs its own authorized assignment.
6. Tell the recipient named by the assignment, or your head under the company escalation route, in one message with message_employee what you proposed, the ones that stopped work the most first. Name tasks that stayed blocked across more than one round. This review proposes changes; it grants no permission to spend, change access or bypass human approvals.

When nothing went wrong and nobody stumbled, say so in one line and stop.
