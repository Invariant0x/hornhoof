---
id: dev-review-diff
title: { en: "Reviewing a change", ru: "Ревью изменения" }
description: { en: "Reads a change against its brief and the engineering rules and finds what will break, whether the change is your own or someone else's.", ru: "Читает изменение против задания и инженерных правил и находит, что сломается, свое это изменение или чужое." }
kind: procedure
sources: [affaan-m/ECC agents/code-reviewer.md, obra/superpowers skills/requesting-code-review/code-reviewer.md, anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/silent-failure-hunter.md, garrytan/gstack review/checklist.md]
---
You can inspect a change against its brief and report confirmed defects.

Read a change against its brief and find what will break. The check is the same for your own change and for someone else's. On your own change, read the diff cold: judge what the code does, not what you meant it to do.

**What to read.** The brief first, then what the candidate changed, `git diff --name-only --diff-filter=d <base>..<commit>` with both taken from task.review (`source.baseCommit` and `commit`), and the code around it; on your own change before you submit it, the base is the commit your branch started from. A narrower scope your task sets, such as a slice or a range of commits, replaces it.

At a one-shot Review stage, follow the ability "One-shot calls". In the brief, give every call the same candidate and base, the acceptance criteria and a distinct part of the diff or review angle. Ask each for file and line evidence. Use the route's judge to combine findings and verify them against the candidate before giving your verdict.

**Your program's own review on a first look only**, from inside the clone on the candidate or slice you review and against that same base: in Claude Code its code-review skill, in Codex `codex review --base` naming a local branch you make at the base commit, in Antigravity its review-agent subagent. Kimi Code has none. Keep the turn's assigned effort without raising it. Its findings are leads: check each against the code, then go through the list below, which it does not replace. When you only recheck fixes, skip your program's own review and never reread the whole patch, whole branch or full diff.

1. **Does it do what the brief asked?** Every requirement met, nothing extra added. Missing work is a finding.
2. **Correctness.** Walk the real inputs through the code: empty, very large, wrong type, duplicate, concurrent, the error path. Name the input and the wrong result for each problem.
3. **Silent failures.** Errors caught and dropped, fallbacks that hide a broken state, defaults that turn a failure into a wrong answer, promises nobody awaits.
4. **Data.** Below version 1.0, before the first release, no compatibility paths or data-conversion code. Correct existing records directly at release. From 1.0 on, migrations safe for existing rows. Transactions where two writes must agree, nothing trusted from outside without a check at the boundary.
5. **Obvious security problems.** An entry point that does not check who asks, input that reaches a query, command or path unchecked, a secret in code, logs or errors. Deeper checks of access, sign-in, secrets and permissions belong to a security review. What the orchestrator can see or do is never a finding to fix: secrets are hidden only from people's screens and the texts people read.
6. **Tests.** First, we test our program, not the operating system and not other programs; second, time in a test is virtual only. A test that checks or waits for another program's work or output, waits on or measures the real clock (a deadline, pause or elapsed-time check), or depends on machine speed, a random port or unsorted order, is a finding: our side of another program is tested on a recorded sample of its output. So is a test replaced by a skip, or a weakened check of our access rights, identity or secret redaction; weakening or deleting any other unstable test is allowed. Do the assigned checks reproduce the named harm? When the assignment requires a separate regression test, does it fail before the fix and pass after it? For a permitted visual check, inspect that evidence instead. Tests check behaviour, not mocks. Never add a byte, character or line budget for instructions or skills to tests, and never shorten an instruction or skill text to fit such a budget. Such an assertion in a test is a finding.
7. **The repository and language rules.** Read the documented style, patterns, security and checks before judging the diff. Duplication, a decision in two places, a function doing three things, a silenced check, dead code.
8. **The numbers.** Read applicable existing `crapper` and `dryer` results when the task requires those measures; do not run them again or demand unassigned final metrics from an author. A CRAP score of 10 or higher in a new or more complex function blocks until resolved; record unchanged old complexity separately. A duplicate scoring 0.8 or higher needs removal or an explicit accepted reason. Read the assigned checker's actual receipts and scope; missing, refused or unsupported measurements are NOT_RUN, not a pass.
9. **Simplicity.** Code that could be half as long and still clear.

**Evidence.** Run your own checks of the change in your workspace, naming test files. Read applicable completed results for the reviewed commit instead of rerunning them, and the author's description of the local checks they ran: rerun what you doubt in your own workspace. A different commit, a selector-only collection or an unavailable stage proves nothing about the reviewed candidate. Ask for additional tests only for a named harm, not a coverage percentage.

**Each finding** has a place (file and line), what goes wrong and the harm to a person. Check it against the code before you report it: a wrong finding costs its reader a round.

**What comes next.** On your own change, fix what blocks, each fix starting with a failing test, and name the rest in your report; your own review replaces no gate. When assigned an independent gate, record a verdict pinned to the actual commit, with all confirmed blocking findings and nonblocking notes; never approve your own work.
