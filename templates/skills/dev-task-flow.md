---
id: dev-task-flow
title: { en: "Code work through tasks", ru: "Работа с кодом через задачи" }
description: { en: "What working through tasks adds when the work is code: a branch per task, commits, the evidence of a submission and the small-task check.", ru: "Что добавляет работа через задачи, когда работа это код: ветка на задачу, коммиты, доказательства при сдаче и проверка маленькой задачи." }
kind: core
---
You can deliver executable work through the required route with exact-version evidence.

Read the current task and task.echelons before changing code. When task.echelons is turnkey, the task is yours end to end alone: code, checks, tests, merge and release as the task says, with no echelons and nobody else called onto it; close it with report done true and the evidence. Work in its named repository and branch, never directly on main. Keep each connected result with one author end to end and one current owner. Preserve other writers' files and workspaces.

Architecture produces a concrete plan unless the task is small. Development writes tests before implementation: observe the intended failure, make the change and run only affected checks, naming them, in your own workspace; whole suites and declared profiles use run_tests. An assignment can widen what is checked, never move change checks to run_tests. Configuration failure, a missing stage or zero selected tests is not PASS.

Commit and push the actual branch. Submit changed paths, requirement -> test links, actual output, full base and candidate SHAs. Every executable result then passes Review. Review owns its repairs in the same branch; ordinary findings do not return to the original author. A result pursuing the wrong goal goes to the head. The next checking owner is another employee using a model not weaker than the producer. Prefer another provider when available; the same provider, subscription or tariff is allowed without waiting for a second provider.

Cleanup is absent by default. Only the head enables this optional stage for a task or turn after Review, using the existing cleanup ability offered off to developers and reviewers. Security follows when the head identifies risk or Review adds it with a reason. Any change affecting access, root, permissions or secrets must pass review by an independent Security engineer before it reaches any shared branch, including the turn's branch. This applies to urgent work, small tasks, direct named orders and review fixes. Self-review does not replace this gate.

Tests checks the final candidate including every repair with applicable delta checks and reusable matching fingerprints. Mutations cover only changed pure functions with direct fast tests. Report finished run and part evidence for that exact candidate. Nothing goes back to an earlier stage. When the candidate's own change passed and it only needs the main line taken in, it stays at Tests: merge the current main line into the candidate's branch, push it, use "submit" with review.baseCommit naming the main commit you took in, and check the new candidate. A coordination-only parent reports accepted current child results without an invented code SHA; unfinished, unaccepted or stale child work blocks it. A parent with executable output follows mandatory Review.

After Tests, follow the task's authorized integration route. A generic wake-up naming another branch cannot override an explicit restriction in the task. Main receives only an exact commit approved by the authorized human owner. Passing checks grants no release, live-data, access or model-change permission.
