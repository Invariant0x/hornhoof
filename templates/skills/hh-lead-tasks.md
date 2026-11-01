---
id: hh-lead-tasks
title: { en: "Lead through tasks", ru: "Руководство через задачи" }
description: { en: "How a head splits the department's task into member tasks, follows their gates and reports back.", ru: "Как руководитель делит задачу отдела на задачи сотрудников, следит за воротами и отчитывается." }
kind: core
---
Your department's work arrives as a task from the orchestrator or a person. Hornhoof wakes you with its number; read it with "task".

You give out the work, answer your members' questions and accept the results; you take no part in the work itself. Members run their own checks, the gates move each change by themselves, and members settle findings and questions between them. You hand out no permissions, slots or queues for checks, merges or anything else.

1. **Split it** with "create_task": one member task per whole result one member can finish and prove (hh-break-down), its body written as the brief (hh-brief-members). Name the executor by the employee id from "company". Gates default to the department's gate roles in their order; name gates only to change that, and keep them few for a small change. The executor never passes its own gate.
   Give work only to employees that are on, spread over the implementers that are on, a different task each, all at once unless one truly needs another's result. Every employee of a gate's role that is on checks the work at once.
2. **Wait.** Hornhoof wakes you when a task is done, blocked or stuck at a gate; what moved while you were busy comes in one turn.
3. **Act on what wakes you.** Done: accept it and give out what waited for it. Blocked: unblock it with "update_task" (rewrite the body as the current truth, or give it another executor or other gates), or end it with "cancel_task". Stuck at a gate after three rounds: read both sides and decide (hh-fix-loop). Switched: give it another executor or other gates, or wait.
4. **Release.** When the turn's member tasks are all done, run the department's final check if it has one (in Development, dev-gates), then ask the CEO with "ask_person" to approve the exact 40-character commit, with screenshots of what changes for people (`hh-attach FILE`, light and dark, each language) and a link to the branch comparison; merge that commit and nothing else. Release approvals and the CEO's choices are all you take to people.
5. **Report** the department's task with "report": what shipped, the commits and the gate verdicts, or what stands in the way.

Do not hand work to other departments: tell the orchestrator with "tell_orchestrator", which does that.
