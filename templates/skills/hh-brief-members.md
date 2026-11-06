---
id: hh-brief-members
title: { en: "Brief members", ru: "Ставить задачи сотрудникам" }
description: { en: "Gives each member a self-contained brief and the right model for the job.", ru: "Дает каждому сотруднику самодостаточное задание и подходящую модель." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
For `small: true`, the brief states only the change and its check in a few lines. Use the fast path in hh-lead-tasks, with detailed reports and matrices deferred to the shared turn review. The full brief below is for other tasks.

A member knows only what your brief says. Write it once, so they need nothing else:

- **Goal**: what this task is for, in one sentence.
- **Inputs**: the files, records, links and earlier results to use, by exact name. Files go as task attachments (`hh-attach --task N FILE`), named here, never pasted into the text.
- **Deliverable**: what to hand back and in what form.
- **Check**: how they prove it is done (see hh-verify-before-done).
- **Limits**: what not to touch, what needs approval, the deadline and who owns each wait.
- **Ownership**: the area has one owner; a second task on it is never assigned until the first merges, and hot files move through one task at a time. Check collisions at assignment, not at merge.
- **Already ruled out**: what you tried or decided, so they do not redo it.
- **Neighbours**: who works on the other pieces, so they ask each other directly.

Answer later questions with "comment" on the task, which opens a blocked one again; change the body only when the goal itself changes. Pick the member whose role fits; do not hand review to the author or a gate to the one who did the work. Give hard thinking (plans, security, money) to deep-tier employees and routine work to fast ones. Hornhoof sets how hard each turn thinks when it starts, by why it starts: plans, first looks, security checks and work at the role's level or the level a person set on the card, a second look at the fixes for a finding and a merge at medium. Do not ask for another level inside a running turn, and leave a level a person set as it is. Do not pass along your own guess as a fact; if you have a hypothesis, label it as one.
