---
id: dev-review-fix
title: { en: "Repair review findings", ru: "Исправлять замечания ревью" }
description: { en: "Use when the current Review owner must repair a confirmed defect in its assigned candidate.", ru: "Для текущего владельца Review, которому надо исправить подтвержденный дефект назначенного кандидата." }
kind: procedure
sources: []
---
You repair confirmed Review findings within the assigned branch and scope.

Read task.echelons, the input candidate, permitted paths and the current owner before editing. One employee writes the same branch at a time. Skill selection grants no new company, repository or path access. A checker is another employee with a model not weaker than the producer. Prefer another provider when available; the same provider, subscription or tariff is allowed without waiting for another one.

Record confirmed defects as structured issues on the exact reviewedCommit. A failed verdict keeps the task with you to fix. Reproduce each blocking defect with a failing test by the assignment's check route on the input commit, make the smallest repair, then run affected checks on the exact pushed fix. Keep requirement-to-test links and read the full finished logs. Never lower a check or threshold to hide a defect.

Submit the corrected candidate forward with its parent, full base and fix SHAs, same branch, changed paths, actual producing model and subscription, and check evidence. Your repair is recorded as authorship; it does not invent another independent review of your own fix. Preserve the original finding and its provenance. Ordinary findings stay with their checker, without a return to the original author. If the result pursues the wrong goal, use verdict with escalate and the evidence for the head to decide.

When Review discovers access, secret, personal-data or external-input risk, add Security with its concrete reason before handoff. Cleanup is absent by default; only the head enables that optional stage after Review, using the existing cleanup ability. Tests verifies the final candidate including all fixes, mutating only changed pure functions with fast tests.

Follow the task's authorized integration route. Passing your checks grants no permission for main, publication, live data, access or model changes.
