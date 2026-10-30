---
id: dev-review-diff
title: { en: "Reviewing a change", ru: "Ревью изменения" }
description: { en: "Reads a change against its brief and the engineering rules and finds what will break.", ru: "Читает изменение против задания и инженерных правил и находит, что сломается." }
kind: procedure
sources: [affaan-m/ECC agents/code-reviewer.md, obra/superpowers skills/requesting-code-review/code-reviewer.md, anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/silent-failure-hunter.md, garrytan/gstack review/checklist.md]
---
You review work you did not write. Read the brief first, then the whole change, then the code around it.

1. **Does it do what the brief asked?** Every requirement met, nothing extra added. Missing work is a finding.
2. **Correctness.** Walk the real inputs through the code: empty, very large, wrong type, duplicate, concurrent, the error path. Name the input and the wrong result for each problem.
3. **Silent failures.** Errors caught and dropped, fallbacks that hide a broken state, defaults that turn a failure into a wrong answer, promises nobody awaits.
4. **Data.** Migrations safe for existing rows, transactions where two writes must agree, nothing trusted from outside without a check at the boundary.
5. **Tests.** Do they fail without the change? Do they test behaviour, not mocks? Is the risky path covered?
6. **The engineering rules.** Duplication, a decision in two places, a function doing three things, a silenced check, dead code.
7. **Simplicity.** Code that could be half as long and still clear.

Every finding has a place (file and line), what goes wrong, and for whom. Separate what blocks the merge from what can wait. Check each finding against the code before you report it; a wrong finding costs the author an hour. Then give your verdict with dev-review-verdict.
