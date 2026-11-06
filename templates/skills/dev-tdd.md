---
id: dev-tdd
title: { en: "Test-driven development", ru: "Разработка через тесты" }
description: { en: "Writes the failing test first, watches it fail, then writes the code that passes it.", ru: "Сначала пишет падающий тест, видит, как он падает, затем пишет код, который его проходит." }
kind: procedure
sources: [obra/superpowers skills/test-driven-development/SKILL.md, obra/superpowers skills/test-driven-development/writing-good-tests.md]
---
For `small: true`, keep the failing-test, change and affected-test cycle, then merge and submit a line with the change and commit SHA (hh-task-flow). Requirement matrices and detailed reports belong to the shared turn review and checks. The full task-kind and reporting procedure below applies to ordinary work.

The head marks one of four task kinds, and the kind chooses the cycle (dev-implement):

- **Bug:** reproduce it with a failing test, then fix it.
- **Known behaviour:** use the red, green, refactor cycle below in small steps.
- **Unknown path:** write one acceptance test first, then timebox a spike, split pure functions, cut the unnecessary and add direct fast tests. A discarded spike needs no tests.
- **Legacy code:** write characterization tests, keep structural commits separate from behaviour commits, then change behaviour under its own test.

For every behaviour you add or change, and for every bug you fix:

1. **Red.** Write one test for one behaviour, named for what it shows ("rejects an empty email"). Use the real code; mock only what you cannot run (the network, the clock, another service).
2. **Watch it fail.** Run that affected test file through `run_tests` (hh-run-checks). It must fail because the behaviour is missing, not because of a typo or an import. A characterization test of legacy code passes immediately, and that is correct: it pins current behaviour before structural work. Any other new behaviour test that passes before the code exists tests nothing; fix the test.
3. **Green.** Write the simplest code that makes it pass. Nothing the test does not ask for.
4. **Run the tests around it** through `run_tests` (hh-run-checks): yours, and those selected for the code you changed and its callers (T2). Every failure goes into your report, even one you did not cause. The whole suite runs only for the final turn candidate (dev-gates).
5. **Refactor** with the tests green: names, duplication, small functions. Run again.

Before you write a test, name the change to the code that would make it fail. If you cannot, the test checks nothing. Assert on outputs and visible effects, not on how many times a mock was called. Keep test helpers in test files, never in production code. Submit with requirement -> test links and verification before done evidence. There is no 80% coverage threshold.
