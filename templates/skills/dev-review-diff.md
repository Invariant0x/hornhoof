---
id: dev-review-diff
title: { en: "Reviewing a change", ru: "Ревью изменения" }
description: { en: "Reads a change against its brief and the engineering rules and finds what will break.", ru: "Читает изменение против задания и инженерных правил и находит, что сломается." }
kind: procedure
sources: [affaan-m/ECC agents/code-reviewer.md, obra/superpowers skills/requesting-code-review/code-reviewer.md, anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/silent-failure-hunter.md, garrytan/gstack review/checklist.md]
---
You review work you did not write. Read the brief first, then the whole change, then the code around it.

**Your program's own review first**, from inside the clone on the task branch: in Claude Code its code-review skill at high effort, in Codex `codex review --base <main line>`, in Antigravity its review-agent subagent. Kimi Code has none. Its findings are leads: check each against the code, then go through the list below, which it does not replace.

1. **Does it do what the brief asked?** Every requirement met, nothing extra added. Missing work is a finding.
2. **Correctness.** Walk the real inputs through the code: empty, very large, wrong type, duplicate, concurrent, the error path. Name the input and the wrong result for each problem.
3. **Silent failures.** Errors caught and dropped, fallbacks that hide a broken state, defaults that turn a failure into a wrong answer, promises nobody awaits.
4. **Data.** Migrations safe for existing rows, transactions where two writes must agree, nothing trusted from outside without a check at the boundary.
5. **Obvious security problems.** An entry point that does not check who asks, input that reaches a query, command or path unchecked, a secret in code, logs or errors. Deeper checks of access, sign-in, secrets and permissions are the security gate's.
6. **Tests.** Do they fail without the change? Do they test behaviour, not mocks? Is the risky path covered?
7. **The engineering rules and the rules of each language** (dev-language-rules). Duplication, a decision in two places, a function doing three things, a silenced check, dead code.
8. **The numbers.** Run `crapper` and `dryer` from the repository root on the files the branch changed (`git diff --name-only --diff-filter=d <main line>...HEAD`). A changed function at CRAP 10 or more, or a duplicate scoring 0.8 or more, is blocking, like a failing test, unless the brief says why it stays. The developer runs them before submitting, so you rarely meet one.
9. **Simplicity.** Code that could be half as long and still clear.

Every finding has a place (file and line), what goes wrong, and for whom. Only what blocks sends the work back (dev-review-verdict); the rest are notes under a pass. On a second round, check only the fixes for your own findings. Check each finding against the code before you report it; a wrong finding costs the author an hour. Then give your verdict with dev-review-verdict.
