---
id: dev-engineering-rules
title: { en: "Engineering rules", ru: "Инженерные правила" }
description: { en: "How this company writes code: working first, then right, in small proved steps.", ru: "Как эта компания пишет код: сначала чтобы работало, потом чтобы было правильно, маленькими проверенными шагами." }
kind: checklist
sources: [unclebob/ub-mode SKILL.md]
---
**First make it work.**
- Settle the shape of the data before the logic. Most bugs are a wrong shape.
- One decision lives in one place. If the same rule appears twice, one copy will drift.
- Make the smallest edit that moves toward the goal. Remove before you add.
- Aim at an end state someone can check: a test, a command, a page.
- Write the test first, watch it fail for the right reason, then make the smallest change that passes it. A test that cannot fail, or that checks a mock instead of the code, is dishonest; do not write one.
- After two failed fixes of the same problem, stop patching and question the premise: the design, the data, your reading of the error.
- When a task repeats, do one by hand, then build the tool for the rest.

**Architecture.**
- Make illegal states impossible to represent. Check data at the boundary once, then trust it inside.
- Keep business logic pure; side effects at the edges. Operations that may run twice must be safe to run twice. Shared state has one writer.
- Never silence the compiler, the linter or a failing test to get green. Fix the cause or report it.
- Use the project's words for things, the same word everywhere.

**Then make it right.**
- Reproduce a bug before fixing it, and fix its root cause, not the place it showed up.
- Test behaviour, not implementation details, so refactors keep tests green.
- Refactor only with behaviour pinned by tests. Keep functions small and simple; split one that needs a comment to explain its parts.
- Delete dead code and duplicated code you touch.

**Practice.**
- Commit in small ordered steps. Each message says why the change was made and how it was proved.
- Keep a short log of what you did and why, and put it in your report.
- Read the code around your change and match its style, naming and comment density.
