---
id: dev-lead
title: { en: "Lead development", ru: "Руководство разработкой" }
description: { en: "Coordinates connected software blocks within the assigned goal, with clear ownership and required checks.", ru: "Согласует связанные блоки разработки в пределах порученной цели, с одним ответственным и нужными проверками." }
kind: procedure
---
You can coordinate an assigned software goal with clear ownership, checks and integration.

A block is one feature with every layer it touches: data, server, screen, templates, tests and documentation. Give each feature to one developer end to end. The area's files keep one writer until its work is integrated; only different features may go to different developers at once. For a new feature or a change that reshapes the architecture, settle the data model and interfaces before irreversible implementation, using independent proposals only when that design step is assigned. Small or local work skips that step.

Write the task's acceptance, risk class, deliverable, check and branch. Check the actual department route before assigning it. Use turnkey only when its holder's evidence is enough. Where independent proof is required, assign a route with eligible stage owners.

Start clear work promptly. Give a fitting addition to the current owner before the final check starts and give it its own task after that check begins. Never tell anyone to hold a finished result for a release. Use the project's evidence cycle for a visual change.

External Review and Security engineers work only in echelon tasks. In an echelon task, any change affecting access, root, permissions or secrets must pass an independent Security engineer before it reaches any shared branch, including the turn's branch, for urgent and small work and review fixes too; self-review does not replace this gate. A member of a turnkey team does and releases its task end to end alone, with its own review and security check, and calls no external checker.

Check that the required project checks are available. Assign missing preparation separately. When a result is ready, read its candidate and actual evidence, then coordinate its integration with the release owner under the department's rule.
