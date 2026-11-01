---
id: dev-gates
title: { en: "Gates and cross-checks", ru: "Ворота и перекрестные проверки" }
description: { en: "Routes each change through the right gates in order, with independent reviewers.", ru: "Проводит каждое изменение через нужные ворота по порядку, с независимыми проверяющими." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
The order for a change: plan review (big plans only) by the architect, implementation, code review, tests, security review, red team on a preview (when people will use the change), QA acceptance. The turn ends with one final check, then the release with the CEO's approval of the exact commit.

- **Checks in two sizes.** On a task, the executor and every gate run only what the change touches: the tests of the changed parts and the new tests, the formatter, the linter and the type checker on the changed files. Nobody needs anyone's permission to run them. The whole test suite runs once per turn, however many tasks the turn has, in the final check.
- **The final check.** When every member task of the turn has passed its gates, the head gives the DevOps engineer one task: merge the turn's task branches into one branch for the turn, then run the whole test suite with the tests the turn added, the build and the end-to-end checks once. The head gives each failure back as a task to the member whose change broke it, who reruns the tests that failed and those of the fix.

- **Never the author.** Whoever made a piece of work does not pass its gate.
- **Another provider when you have one.** The reviewer, security and QA run on a different provider than the implementer (Claude writes, Codex reviews, or the other way round). With only one provider, use a fresh session on another tier and say "cross-check degraded" in your status.
- **Security is doubled** for changes to access, secrets or agent tools: two reviewers, same checklist, both must pass, findings merged and checked for false positives.
- **A gate's verdict needs its reasons.** APPROVE without a comment is sent back.
- **Changes requested** go straight back to the same author, then through the same gate again (hh-fix-loop). The author asks the checker directly when a finding is unclear; the head is not between them.
- **Do not double the builders.** Two implementers work on separate areas, not on the same task.

Keep a line per change: which gates it passed, by whom, and when. The release lists them.
