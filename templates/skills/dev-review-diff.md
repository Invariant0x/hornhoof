---
id: dev-review-diff
title: { en: "Reviewing a change", ru: "Ревью изменения" }
description: { en: "Reads a change against its brief and the engineering rules and finds what will break, whether the change is your own or someone else's.", ru: "Читает изменение против задания и инженерных правил и находит, что сломается, свое это изменение или чужое." }
kind: procedure
sources: [affaan-m/ECC agents/code-reviewer.md, obra/superpowers skills/requesting-code-review/code-reviewer.md, anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/silent-failure-hunter.md, garrytan/gstack review/checklist.md]
---
Read a change against its brief and find what will break. The check is the same for your own change and for someone else's. On your own change, read the diff cold: judge what the code does, not what you meant it to do.

**What to read.** The brief first, then what the branch changed, `git diff --name-only --diff-filter=d <main line>...HEAD`, and the code around it. A narrower scope your task sets, such as a slice or a range of commits, replaces the branch.

**Your program's own review on a first look only**, from inside the clone on the branch or slice you review: in Claude Code its code-review skill, in Codex `codex review --base <main line>`, in Antigravity its review-agent subagent. Kimi Code has none. Keep the turn's assigned effort without raising it. Its findings are leads: check each against the code, then go through the list below, which it does not replace. When you only recheck fixes, skip your program's own review and never reread the whole patch, whole branch or full diff.

1. **Does it do what the brief asked?** Every requirement met, nothing extra added. Missing work is a finding.
2. **Correctness.** Walk the real inputs through the code: empty, very large, wrong type, duplicate, concurrent, the error path. Name the input and the wrong result for each problem.
3. **Silent failures.** Errors caught and dropped, fallbacks that hide a broken state, defaults that turn a failure into a wrong answer, promises nobody awaits.
4. **Data.** Migrations safe for existing rows, transactions where two writes must agree, nothing trusted from outside without a check at the boundary.
5. **Obvious security problems.** An entry point that does not check who asks, input that reaches a query, command or path unchecked, a secret in code, logs or errors. Deeper checks of access, sign-in, secrets and permissions belong to a security review.
6. **Tests.** Do they fail without the change, and does every bug or review fix start with a failing test (T6)? Do they test behaviour, not mocks?
7. **The engineering rules and the rules of each language** (dev-engineering-rules, dev-language-rules). Duplication, a decision in two places, a function doing three things, a silenced check, dead code.
8. **The numbers.** `crapper` and `dryer` run at the testing gate, after review, so a review neither runs them nor asks the author for them. When the reviewed commit already has their results from the test engineer or QA's shared final check, read them against its scope; T11 says what blocks.
9. **Simplicity.** Code that could be half as long and still clear.

**Evidence.** Read what was proved on the reviewed commit instead of rerunning its tests (T10): a run on another commit proves nothing about what you review. T1, T6, T10 and T11 are in dev-testing-policy.

**Each finding** has a place (file and line), what goes wrong and the harm to a person. Check it against the code before you report it: a wrong finding costs its reader a round.

**What comes next.** On your own change, fix what blocks, each fix starting with a failing test, and name the rest in your report; your own review replaces no gate. On someone else's change at a gate, give the verdict with dev-review-verdict.
