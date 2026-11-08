---
id: dev-security-fix
title: { en: "Repair security findings", ru: "Исправлять замечания безопасности" }
description: { en: "Repairs confirmed security defects when the assignment gives the employee ownership of Security fixes.", ru: "Исправляет подтвержденные дефекты безопасности, когда сотруднику поручено владеть исправлениями на Security." }
kind: procedure
sources: []
---
You can close a confirmed security weakness within an assigned repair boundary.

Verify the current stage owner, input candidate, permitted scope and handed-off branch. Keep one writer and reject stale candidate or ownership claims. Selecting this ability does not widen company, repository or path access. An independent legacy gate with no repair assignment stays read-only.

Trace the confirmed attack from its entry point to the protected data or action. Write a failing regression test for the concrete unauthorized access, input, secret exposure or data loss. Through run_tests, observe that failure on the pinned input before changing the safeguard. Repair the cause, check both the rejected attack and the allowed operation, and run only affected checks on the exact candidate. Use isolated fixtures; do not probe production or real personal data.

Keep a server-bound finding identity with its original input SHA and evidence. Record the corrected SHA as a child candidate with the actual fixer and model, without erasing history or self-confirming a finding. Retain Security ownership during the repair, then hand the verified candidate forward to Tests; never return ordinary findings to the author. A wrong goal goes to the head with the unchanged requirement and evidence. Missing authority, an out-of-scope repair or uncertain protection also needs an explicit head decision.

Obtain independent Security approval from a different approver for any sensitive repair before a shared branch merge. Fixing code is not approving your own access, root, permissions or secret changes. Keep the branch separate while that approval is missing, even when the current stage's tests pass.

Deliver the source finding, input and fix candidates, full SHAs, affected-test selection, completed run logs and remaining risks. Tests must use the resulting candidate, including this repair. Reused evidence must match its code, tests and environment fingerprint. Neither passing tests nor a quiet finding count automatically removes required protection or authorizes main, publication or live changes.
