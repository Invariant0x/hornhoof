---
id: dev-gates
title: { en: "Gates and cross-checks", ru: "Ворота и перекрестные проверки" }
description: { en: "Reviews each turn once, with every reviewer at the same time, and gives a task a gate of its own only where it must have one.", ru: "Проверяет каждый ход один раз, всеми проверяющими одновременно, и дает задаче свои ворота, только когда без них нельзя." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
For `small: true`, there are no separate task gates: the executor runs only affected tests and merges into the turn's branch. Detailed reports, matrices, complexity metrics and duplicate checks belong to the shared turn review and checks, not the individual task.

**One review per turn.** Work goes out without gates, under the department's task of the turn: each executor merges its branch into the turn's branch as soon as it hands the work in. When the department's last work of the turn is in, Hornhoof opens the review of the turn: of each gate role one reviewer of each provider, the least busy, checks everything the turn changed on its branch at the same time (dev-review-diff), and each runs its program's own review. Reviewers verify the author's affected-test evidence and the test engineer or QA's final results without rerunning their checks.

- **Code review** checks the code, the tests and obvious security problems. **Security**, when it is on, checks what touches access, sign-in, secrets or permissions. **Red team**, when on, checks the changed logic and flows. Security and red team join for declared money/access/security/data risk, sensitive changed paths, risky added diff or explicit pre-release mode. A missing or incomplete trusted comparison wakes both. Harmless UI/text outside these triggers does not wake either. Performance and released-version red-team improvement lanes are nonblocking and never task or turn gates.
- **The verdicts come to the head in one list**, what blocks first. The head gives each blocking finding as a fix task without gates to the member whose change it is, all at once. Each fix starts with a test that fails and then passes; there is no second review. A note that does not block goes into those tasks only when it is cheap.
- **A gate on one task** only where a change must not reach the turn's branch unchecked, such as a migration that rewrites existing data. Research, reports, plans, docs and the architect's design note never get one; the head reads them when they come back.
- **Tests** are never a gate: the test engineer runs the turn's final check. **Acceptance and QA** run once per turn, on the turn's branch.

The turn ends with one review, one final check, then the release with the CEO's approval of the exact commit.

- **Checks by stage (T3).** Developers write a failing test before the change, run only affected tests through `run_tests`, and submit the tests written, green results and commit SHA. The test engineer or QA owns the remaining checks once per turn on the final candidate; reviewers use those results. Use this same table everywhere:

| Stage | Checks |
|---|---|
| Small task (`small: true`) | Failing test, change and only affected tests; extra checks at the shared turn review. |
| In work (ordinary tasks) | Failing test, change and only affected tests through run_tests (T2). |
| After a batch merges | The batch's affected tests on one pinned commit. |
| Final turn candidate | Test engineer or QA: the whole suite, typecheck of tests and applications, build, language checks, browser engines, mutation, coverage and CRAP, dryer, real database and live program checks. |

  Under T2, the author runs only the dependent tests selected from the changed files through `run_tests`, and always includes newly added test files; changes to paths outside the import graph, unsupported or unavailable adapters, or any doubt require the complete affected package, and database migrations run both up and down (reporting explicitly when either direction is unsupported). Until impact selection is connected to the test-environment runner, invoke the repository's selector helpers under `scripts/test/` explicitly instead of assuming automatic selection inside `run_tests`. Impact selection and test execution are distinct evidence: a collected graph proves which units were selected, whereas only completed test receipts on that exact commit prove execution, and missing full-suite comparator evidence is `unavailable`, not zero misses. The whole suite runs only for the final turn candidate, never on a task, a fix round or a batch, and that single final whole-suite candidate on the turn's branch remains the test engineer's responsibility. Every check names its commit; its evidence counts while that is the commit being reviewed. A large run may be split across machines only when the split pays for itself and its parts take roughly equal time.
- **The final check.** The head assigns a test engineer or QA to run the final checks once per turn on the final pinned commit: the whole test suite, test/application types, build, format and lint, all browser engines, mutation tests, coverage and CRAP metrics, dryer, real database tests and live program checks on nodes. Coordinate ownership so each check runs once, through run_tests on a compatible free machine. Each finding goes back to its author as a task; small fixes use the fast path. After fixes run only failed and affected checks; do not repeat the whole suite for each fix. QA accepts the turn against these final results.

- **Never the author.** Whoever made a piece of work does not pass its gate.
- **Other providers check.** Reviewers run on other providers than the developer when you have them. With only one provider, use a fresh session on another tier and say "cross-check degraded" in your status.
- **Only what blocks sends work back** to its author (dev-review-verdict, hh-fix-loop), every blocking finding in one verdict; the rest are notes under a pass, which the author may fix in passing. At a gate of one task, **a second round checks only the fixes**, by the reviewers who sent it back, each for its own findings; one that passed is not asked again.
- **Do not double the builders.** Two developers work on separate features, not on the same task.
