---
id: dev-plan-review
title: { en: "Plan review", ru: "Ревью плана" }
description: { en: "Reads a big plan when the head asks and says what to change, as advice and not a gate.", ru: "Читает крупный план, когда просит руководитель, и говорит, что изменить: это совет, а не ворота." }
kind: gate
sources: [garrytan/gstack plan-eng-review/SKILL.md.tmpl, affaan-m/ECC agents/architect.md, affaan-m/ECC skills/architecture-decision-records/SKILL.md]
---
When the head asks you to read a big plan, it is advice inside the task, not a gate before it. Read the goal first, then the plan.

Check:
- **Fit**: every requirement of the goal has a task; nothing in the plan is outside the goal.
- **Shape**: the data model is right before the logic; one decision in one place; parts have clear boundaries and the interfaces match between tasks.
- **Risk first**: the riskiest unknown is answered early, with a spike if needed.
- **Failure paths**: errors, retries, partial failure, migrations of existing data, going back to the previous version.
- **Tests**: each task names a test that fails first and proves the behaviour, with real values.
- **Security and cost**: trust boundaries are named; nothing needs more access than it uses; no surprise spend.
- **Size**: tasks small enough to review; the plan shorter than the code it describes.

Verdict: APPROVE, REVISE (with the exact changes) or REJECT (the approach is wrong; say why and what instead). For a decision that will be hard to undo, write a short decision record: context, the choice, the options rejected, the cost if wrong. When you and a second reviewer disagree, both positions go to the CEO through the head.
