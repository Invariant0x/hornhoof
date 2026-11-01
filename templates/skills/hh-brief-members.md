---
id: hh-brief-members
title: { en: "Brief members", ru: "Ставить задачи сотрудникам" }
description: { en: "Gives each member a self-contained brief and the right model for the job.", ru: "Дает каждому сотруднику самодостаточное задание и подходящую модель." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md]
---
A member knows only what your brief says. Write it once, so they need nothing else:

- **Goal**: what this task is for, in one sentence.
- **Inputs**: the files, records, links and earlier results to use, by exact name. Files go as task attachments (`hh-attach --task N FILE`), named here, never pasted into the text.
- **Deliverable**: what to hand back and in what form.
- **Check**: how they prove it is done (see hh-verify-before-done).
- **Limits**: what not to touch, what needs approval, the deadline.
- **Already ruled out**: what you tried or decided, so they do not redo it.
- **Neighbours**: who works on the other pieces, so they ask each other directly.

Do not rewrite it later: answer questions with message_employee, and add an answer that unblocks the task to its body, leaving the rest as written. Pick the member whose role fits; do not hand review to the author or a gate to the one who did the work. Give hard thinking (plans, security, money) to deep-tier employees and routine work to fast ones. Do not pass along your own guess as a fact; if you have a hypothesis, label it as one.
