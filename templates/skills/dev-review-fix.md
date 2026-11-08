---
id: dev-review-fix
title: { en: "Repair review findings", ru: "Исправлять замечания ревью" }
description: { en: "Repairs confirmed code defects when the assignment gives the employee ownership of Review fixes.", ru: "Исправляет подтвержденные дефекты кода, когда сотруднику поручено владеть исправлениями на Review." }
kind: procedure
sources: []
---
You can repair confirmed review findings and hand the corrected candidate forward.

Read the task, its current owner, input candidate and assigned repair scope before editing. Use the task's handed-off branch with one writer at a time. The current stage owner keeps ownership while repairing; a selected ability alone grants no access to another task, repository or path. A legacy independent gate without repair ownership remains read-only.

Reproduce each confirmed defect with a failing regression test first. Run that test through run_tests on the pinned input, make the smallest repair and run affected tests on the exact candidate containing the fix. Check correctness, error handling, data boundaries, material simplicity and basic security. Do not lower a test or threshold to make a finding disappear.

Record the source finding once, its input candidate and the fix's full SHA with the task's tools. Append the corrected candidate with its parent, branch, changed paths and actual producing model; preserve earlier evidence and findings. An old PASS does not prove a new SHA. After the required checks succeed, hand the corrected result forward; never return an ordinary finding to the original author. If the work pursues the wrong goal, preserve the evidence and escalate to the head instead of rewriting the goal.

When Review discovers a risk to access, secrets, personal data or external input, request Security on the route with its reason before handing onward. Use the configured different-model and stronger-model policy against the actual input producer; an unavailable eligible checker is a waiting condition for the head, never a same-model fallback.

Changes affecting access, root, permissions or secrets require independent Security approval on the corrected exact SHA before any shared branch integration. Your repair is authorship and cannot approve itself. Give the next owner the branch, candidate lineage, requirement -> test links, actual run IDs, logs and unresolved concerns. Release and main still require the authorized human's exact-commit decision.
