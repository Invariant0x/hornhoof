---
id: dev-review-diff
kind: procedure
sources: [affaan-m/ECC agents/code-reviewer.md, obra/superpowers skills/requesting-code-review/code-reviewer.md, anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/silent-failure-hunter.md, garrytan/gstack review/checklist.md]
---
You can inspect a change against its brief and report confirmed defects.

Read a change against its brief and find what will break. The check is the same for your own change and for someone else's. On your own change, read the diff cold: judge what the code does, not what you meant it to do.

**What to read.** The brief first, then what the candidate changed, `git diff --name-only --diff-filter=d <base>..<commit>` with both taken from task.review (`source.baseCommit` and `commit`), and the code around it; on your own change before you submit it, the base is the commit your branch started from. A narrower scope your task sets, such as a slice or a range of commits, replaces it.

At a one-shot Review stage, follow the ability "One-shot calls". In the brief, give every call the same candidate and base, the acceptance criteria and a distinct part of the diff or review angle. Ask each for file and line evidence. Use the route's judge to combine findings and verify them against the candidate before giving your verdict.

On the first look, use a review facility available in the current environment if it covers the exact candidate and base. Treat its findings as leads and verify them against the source. On recheck, inspect the fixes and the behavior they affect.

1. **Does it do what the brief asked?** Every requirement met, nothing extra added. Missing work is a finding.
2. **Correctness.** Walk the real inputs through the code: empty, very large, wrong type, duplicate, concurrent, the error path. Name the input and the wrong result for each problem.
3. **Silent failures.** Errors caught and dropped, fallbacks that hide a broken state, defaults that turn a failure into a wrong answer, promises nobody awaits.
4. **Data.** Check upgrade, compatibility and rollback against the deployed readers and existing records. Keep coordinated writes consistent and check untrusted input at its boundary.
5. **Security boundaries.** Check authority at entry points and see how input reaches queries, paths and commands. Report unintended disclosure and incorrect attribution, including when owner access is involved.
6. **Tests.** Check that the assigned evidence proves the named behavior on the exact candidate. For regressions, inspect the failure before the fix and pass after. Preserve proof of actual product behavior and reject checks that depend on host speed. Never add a byte, character or line budget for instructions or skills to tests, and never shorten an instruction or skill text to fit such a budget. Such an assertion in a test is a finding.
7. **The repository and language rules.** Read the documented style, patterns, security and checks before judging the diff. Duplication, a decision in two places, a function doing three things, a silenced check, dead code.
8. **Quality measurements.** Read the assigned checker's actual scope and result. Explain the concrete problem a measurement reveals and mark unavailable evidence NOT_RUN.
9. **Simplicity.** Flag complexity when a simpler implementation preserves behavior and makes a concrete maintenance task easier.

**Evidence.** Run your own checks of the change in your workspace, naming test files. Read applicable completed results for the reviewed commit instead of rerunning them, and the author's description of the local checks they ran: rerun what you doubt in your own workspace. A different commit, a selector-only collection or an unavailable stage proves nothing about the reviewed candidate. Ask for additional tests only for a named harm, not a coverage percentage.

**Each finding** has a place (file and line), what goes wrong and the harm to a person. Check it against the code before you report it: a wrong finding costs its reader a round.

**What comes next.** On your own change, fix what blocks, each fix starting with a failing test, and name the rest in your report; your own review replaces no gate. When assigned an independent gate, record a verdict pinned to the actual commit, with all confirmed blocking findings and nonblocking notes; never approve your own work.
