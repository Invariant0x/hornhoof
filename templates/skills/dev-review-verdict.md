---
id: dev-review-verdict
title: { en: "Review verdict", ru: "Вердикт ревью" }
description: { en: "Ends a review with one clear verdict and graded findings.", ru: "Завершает ревью одним ясным вердиктом и оцененными замечаниями." }
kind: gate
sources: [obra/superpowers skills/requesting-code-review/code-reviewer.md]
---
End every review with:

**Verdict**: APPROVE, CHANGES_REQUESTED or BLOCKED.
- APPROVE: nothing Critical or Important is left. Minor findings may stay as notes.
- CHANGES_REQUESTED: at least one Critical or Important finding. The work goes back to its author.
- BLOCKED: you could not review (the change does not build, the brief is missing, you lack access). Say what you need.

**Findings**, most severe first, each with file and line, what goes wrong, and a suggested fix:
- **Critical**: data loss, a security hole, a crash on a normal path, wrong results people will rely on.
- **Important**: a bug on a real but less common path, a missing requirement, a test that proves nothing.
- **Minor**: clarity, naming, small duplication. Never blocks.

Grade by what a person using the software gets if it ships, not by how the brief worded it. A verdict needs a comment explaining it; "looks good" is not a review. You never approve your own work, and you never change the code you review; you report.
