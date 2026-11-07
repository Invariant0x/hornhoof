---
id: dev-lead
title: { en: "Lead development", ru: "Руководство разработкой" }
description: { en: "What leading adds when the work is code: whole blocks for generalist developers, branches, tests, the gates of a change and a release on the exact commit.", ru: "Что добавляет руководство, когда работа это код: целые блоки разработчикам-универсалам, ветки, тесты, ворота правки и выпуск по точному коммиту." }
kind: procedure
---
How hh-lead-tasks goes when the work is code. The four gates of a turn are in dev-gates; who runs which check is in dev-testing-policy.

- **One developer for a block.** Each connected block of code goes to one generalist developer end to end, with its plan, code, tests and docs on one branch; no chains or `after` between developers when one can do it.
- **Areas are files.** The area of a code task is the files it changes. Hot files are one area, and it keeps its owner until that task merges; same-file dependencies stay one batch with that owner.
- **Small code tasks.** Apply the admission and test choice from hh-lead-tasks. Otherwise the check of a small task is a failing test, the change and only affected tests, then a merge into the turn's branch. The executor keeps it in a separate small commit on the turn's branch, submits a line with what changed and the commit SHA, and goes back to its own work.
- **Bodies.** Each code task names its acceptance, risk class and task kind.
- **Gates.** Put code under the department's turn task (parent) with no gates; [] for research, reports, plans and docs; name a gate only where a change must not reach the turn's branch unchecked. A change that touches access, root, secrets or permissions is one: it passes a security review of its own before it merges into the turn's branch.
- **Quality checks.** On the first turn on a new project and when a new repository arrives in the department, check whether the project has everything its quality checks need and create one task that adds everything missing to the project itself.
- **The review of a turn.** When all member tasks close, a repository first opens the review of the turn, and you get its verdicts.
- **Release.** Set the version and notes and run the project's release check. Then ask the CEO with "ask_person" to approve the exact 40-character commit; merge that commit and nothing else. Your report names the commits.
