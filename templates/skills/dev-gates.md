---
id: dev-gates
title: { en: "Gates and cross-checks", ru: "Ворота и перекрестные проверки" }
description: { en: "Gives each change only the gates its size and risk need, with independent reviewers.", ru: "Дает каждому изменению только те ворота, которых требуют его размер и риск, с независимыми проверяющими." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/SKILL.md, affaan-m/ECC skills/council-multi-model/SKILL.md, affaan-m/ECC skills/santa-method/SKILL.md]
---
**Gates by size and risk.** The head names a task's gates when it gives it out:

- **Research, reports, plans and docs get no gates**, nor does the architect's design note. The head reads them when they come back.
- **Code gets one review stage**: one reviewer per provider of the review role, the least busy of each, checks the same change at once, its code, its tests and obvious security problems in one pass. Each runs its program's own review, crapper and dryer, and the checklist (dev-review-diff).
- **Security**, when it is switched on, is a gate only when the change touches access, sign-in, secrets or permissions.
- **Tests** are never a gate on a task: the test engineer runs the turn's final check. **Red team**, when on, only on risky or public-facing changes, never small ones.
- **Acceptance and QA** run once per turn, on the turn's branch, not on every task.

The turn ends with one final check, then the release with the CEO's approval of the exact commit.

- **Checks in two sizes.** On a task, the executor and every gate run only what the change touches: the tests of the changed parts and the new tests, the formatter, the linter and the type checker on the changed files. Nobody needs anyone's permission to run them. The whole test suite runs once per turn, in the final check, through run_tests: it goes to a free machine of the company, in parts when its runner can split.
- **The final check.** Each executor merges its branch into the turn's branch once its gates pass. When every member task of the turn is done, the head gives one task to the test engineer, or to the DevOps engineer when there is none, or runs run_tests itself when there is neither, never to a developer: run the whole test suite with the tests the turn added, the build and the end-to-end checks once on the turn's branch. The QA lead, when there is one, accepts the turn there. Each failure goes back as a task to the member whose change broke it. After the fixes only what failed and the tests around it run again; the whole suite runs again only before the release.

- **Never the author.** Whoever made a piece of work does not pass its gate.
- **Other providers check.** Reviewers run on other providers than the developer when you have them. With only one provider, use a fresh session on another tier and say "cross-check degraded" in your status.
- **Only what blocks sends work back** to its author (dev-review-verdict, hh-fix-loop), every blocking finding in one verdict; the rest are notes under a pass, which the author may fix in passing. **A second round checks only the fixes**, by the reviewers who sent it back, each for its own findings; one that passed is not asked again.
- **Do not double the builders.** Two developers work on separate features, not on the same task.
