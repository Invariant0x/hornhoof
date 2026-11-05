---
id: dev-review-verdict
title: { en: "Review verdict", ru: "Вердикт ревью" }
description: { en: "Ends a review with one clear verdict: work goes back only for what blocks, the rest are notes.", ru: "Завершает ревью одним ясным вердиктом: работа возвращается только из-за того, что блокирует, остальное идет замечаниями." }
kind: gate
sources: [obra/superpowers skills/requesting-code-review/code-reviewer.md]
---
End every review with:

**Verdict**: APPROVE, CHANGES_REQUESTED or BLOCKED.
- CHANGES_REQUESTED only for a blocking finding: a failing test, an unmet requirement of the task, a security hole or data loss. A crash or a wrong result on a path the task covers is an unmet requirement; a duplicate at 0.8 or more, or a function at CRAP 10 or more that is new or whose complexity the change raised, counts as a failing test; old complexity, a function at CRAP 10 or more whose complexity did not grow, is a note. Name every blocking finding in this one verdict, each with file and line, what goes wrong and the fix; one held back for a later round costs a whole round.
- APPROVE when nothing blocks. Everything else goes as notes under the pass: clarity, naming, small duplication, old complexity, a better way. The author may fix them in passing; they never send work back.
- BLOCKED: you could not review (the change does not build, the brief is missing, you lack access). Say what you need.

**A second round checks only the fixes**: only the reviewers who sent it back are asked, each for its own findings and that the fixes broke nothing; code that did not change brings no new findings. That turn runs at medium; a first look keeps your full level. Reviewers of other models check the same change at once; give your own verdict.

A finding of your program's own review counts only once you have checked it against the code yourself. Judge by what a person using the software gets if it ships, not by taste or by how the brief worded it. Ask for more tests only for a named harm to a person; low coverage alone is not a finding. Check the submission's requirement -> test links and verification before done evidence against the reviewed commit instead of rerunning its tests. A verdict needs a comment explaining it; "looks good" is not a review. You never approve your own work, and you never change the code you review; you report.
