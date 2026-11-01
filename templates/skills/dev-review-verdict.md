---
id: dev-review-verdict
title: { en: "Review verdict", ru: "Вердикт ревью" }
description: { en: "Ends a review with one clear verdict: work goes back only for what blocks, the rest are notes.", ru: "Завершает ревью одним ясным вердиктом: работа возвращается только из-за того, что блокирует, остальное идет замечаниями." }
kind: gate
sources: [obra/superpowers skills/requesting-code-review/code-reviewer.md]
---
End every review with:

**Verdict**: APPROVE, CHANGES_REQUESTED or BLOCKED.
- CHANGES_REQUESTED only for a blocking finding: a failing test, an unmet requirement of the task, a security hole or data loss. A crash or a wrong result on a path the task covers is an unmet requirement. Name every blocking finding in this one verdict, each with file and line, what goes wrong and the fix; one held back for a later round costs a whole round.
- APPROVE when nothing blocks. Everything else goes as notes under the pass: clarity, naming, small duplication, a better way. The author may fix them in passing; they never send work back.
- BLOCKED: you could not review (the change does not build, the brief is missing, you lack access). Say what you need.

**A second round checks only the fixes** for what was sent back, and that they broke nothing; code that did not change brings no new findings.

Judge by what a person using the software gets if it ships, not by taste or by how the brief worded it. A verdict needs a comment explaining it; "looks good" is not a review. You never approve your own work, and you never change the code you review; you report.
