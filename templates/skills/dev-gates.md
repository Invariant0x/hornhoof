---
id: dev-gates
title: { en: "Gates and cross-checks", ru: "Ворота и перекрестные проверки" }
description: { en: "Reviews each turn once, with every reviewer at the same time, and gives a task a gate of its own only where it must have one.", ru: "Проверяет каждый ход один раз, всеми проверяющими одновременно, и дает задаче свои ворота, только когда без них нельзя." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
**One review per turn.** Work goes out without gates: each executor merges its branch into the turn's branch as soon as it hands the work in. When the department's last work of the turn is in, Hornhoof opens the review of the turn: of each gate role one reviewer of each provider, the least busy, checks everything the turn changed on its branch at the same time (dev-review-diff), and each runs its program's own review, crapper and dryer once for the whole turn.

- **Code review** checks the code, the tests and obvious security problems. **Security**, when it is on, checks what touches access, sign-in, secrets or permissions. **Red team**, when on, checks what is risky or public-facing.
- **The verdicts come to the head in one list**, what blocks first. The head gives each blocking finding as a fix task without gates to the member whose change it is, all at once. Each fix starts with a test that fails and then passes; there is no second review. A note that does not block goes into those tasks only when it is cheap.
- **A gate on one task** only where a change must not reach the turn's branch unchecked, such as a migration that rewrites existing data. Research, reports, plans, docs and the architect's design note never get one; the head reads them when they come back.
- **Tests** are never a gate: the test engineer runs the turn's final check. **Acceptance and QA** run once per turn, on the turn's branch.

The turn ends with one review, one final check, then the release with the CEO's approval of the exact commit.

- **Checks in two sizes.** On a task and in the review, the executor and every reviewer run only what the change touches: the tests of the changed parts and the new tests, the formatter, the linter and the type checker on the changed files. Nobody needs anyone's permission to run them. The whole test suite runs once per turn, in the final check, through run_tests: it goes to a free machine of the company, in parts when its runner can split.
- **The final check.** When the fixes of the review are in, or every reviewer passed the turn, the head gives one task to the test engineer, or to the DevOps engineer when there is none, or runs run_tests itself when there is neither, never to a developer: run the whole test suite with the tests the turn added, the build and the end-to-end checks once on the turn's branch. The QA lead, when there is one, accepts the turn there. Each failure goes back as a task to the member whose change broke it. After the fixes only what failed and the tests around it run again; the whole suite runs again only before the release.

- **Never the author.** Whoever made a piece of work does not pass its gate.
- **Other providers check.** Reviewers run on other providers than the developer when you have them. With only one provider, use a fresh session on another tier and say "cross-check degraded" in your status.
- **Only what blocks sends work back** to its author (dev-review-verdict, hh-fix-loop), every blocking finding in one verdict; the rest are notes under a pass, which the author may fix in passing. At a gate of one task, **a second round checks only the fixes**, by the reviewers who sent it back, each for its own findings; one that passed is not asked again.
- **Do not double the builders.** Two developers work on separate features, not on the same task.
