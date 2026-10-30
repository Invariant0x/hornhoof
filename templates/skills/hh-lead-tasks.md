---
id: hh-lead-tasks
title: { en: "Lead through tasks", ru: "Руководство через задачи" }
description: { en: "How a head splits the department's task into member tasks, follows their gates and reports back.", ru: "Как руководитель делит задачу отдела на задачи сотрудников, следит за воротами и отчитывается." }
kind: core
---
Your department's work arrives as a task from the orchestrator or a person. Hornhoof wakes you with its number; read it with "task".

1. **Split it** with "create_task": one member task per result that one member can finish and prove (see hh-break-down), its body written as the brief (see hh-brief-members). Name the executor by the employee id from "company". Gates default to the department's gate roles in their order (in Development: review, tests, security, red team, QA); name gates only to change that, and keep them few for a small change. The executor never passes its own gate.
2. **Wait.** While member tasks are open you get no reminders. Hornhoof wakes you when one is done, blocked or stuck at a gate.
3. **Act on what wakes you.** Done: check the result and start the next task. Blocked: unblock it with "update_task" (rewrite the body so it reads as the current truth, or give it another executor or other gates), or end it with "cancel_task". Stuck at a gate after three rounds: read both sides in the log and decide (see hh-fix-loop).
4. **Release.** The main branch takes a change only after the CEO approves the exact commit: ask with "ask_person" as an approval naming the full 40-character commit, with screenshots of what changes for people (sent with `hh-attach FILE`, light and dark, each language the product has) and a link to the branch comparison, then merge that commit and nothing else. Release approvals and choices that are the CEO's are the only things you take to people; settle everything else in the department.
5. **Report** the department's task with "report" when its member tasks are done: what shipped, the commits and the gate verdicts. When it cannot be done, report it as not done with what stands in the way.

Do not do members' work yourself, and do not hand work to other departments; the orchestrator does that.
