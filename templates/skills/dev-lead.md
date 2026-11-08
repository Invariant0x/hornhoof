---
id: dev-lead
title: { en: "Lead development", ru: "Руководство разработкой" }
description: { en: "Coordinates connected software blocks within the assigned goal, with clear ownership and required checks.", ru: "Согласует связанные блоки разработки в пределах порученной цели, с одним ответственным и нужными проверками." }
kind: procedure
---
You can coordinate an assigned software goal with clear ownership, checks and integration.

Give each connected block to one developer end to end, with its code, tests and relevant documentation, rather than splitting a dependency chain between developers. The area's files keep one writer until its work is integrated; different independent blocks may proceed together. For new or large work settle the data model and interfaces before irreversible implementation, using independent proposals only when that design step is assigned.

Write each task's acceptance, risk class, inputs, deliverable, check, branch and integration route. The employee assignment determines whether one owner closes the whole order or hands it to a named checker. Do not add a shared chain just because this ability is enabled.

A turn is a sprint without a rule of days or hours; preserve real waiting deadlines. Pass a small addition to the contextual owner when it fits before the final gate starts, without an extra CEO-now instruction or an urgency flag. If it would reset a gate already running, place it in the next turn. A simple visual change may use the check the head chooses, including a shared check when that is the assigned route. Required independent approvals still apply.

Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate.

Check whether a newly received project has the tools its required checks need. Assign missing project configuration explicitly rather than installing tools in employees' terminals. Read exact-version evidence and required verdicts before accepting a result. When responsible for a release, prepare its version and notes, obtain the authorized human's exact-commit approval and integrate only that commit by the assigned route.
