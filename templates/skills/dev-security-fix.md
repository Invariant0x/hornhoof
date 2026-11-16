---
id: dev-security-fix
title: { en: "Repair security findings", ru: "Исправлять замечания безопасности" }
description: { en: "Use when the current Security owner must repair a confirmed weakness in its assigned candidate.", ru: "Для текущего владельца Security, которому надо исправить подтвержденную уязвимость назначенного кандидата." }
kind: procedure
sources: []
---
You repair confirmed Security findings within the assigned branch and scope.

Read task.echelons and the input candidate first. Verify the current owner, model, subscription, permitted repository paths and same branch. One employee writes that branch at a time. Selecting this ability grants no additional access. The initial checker is another employee with a model not weaker than the input producer; another provider is preferred when available, while the same provider, subscription or tariff is allowed.

Trace the confirmed attack from its input to the protected data or action. Record a structured finding with its original candidate and SHA. Write a failing regression for the concrete access, input, secret exposure or data-loss harm. Use isolated fixtures, observe the intended failure by the assignment's check route, repair the cause, then check the rejected attack and allowed operation on the exact pushed fix. Keep real data and live systems out of those checks.

Keep Security ownership while fixing the defect. Submit the corrected result as a child candidate with full base and fix SHAs, same branch, changed paths, actual fixer and model, and affected evidence. Preserve the original finding; producing a repair neither confirms your own finding nor invents another independent review. Hand the corrected candidate forward to Tests, without returning ordinary findings to the original author. A wrong goal, missing authority or repair beyond the approved paths goes to the head for a decision.

Tests verifies the final candidate including this repair; mutations cover only changed pure functions with fast tests. A missing or failed required check remains explicit. Use the task's authorized integration route; stage completion does not authorize main, publication, live data, permissions or model changes.
