---
id: dev-tdd
title: { en: "Test-driven development", ru: "Разработка через тесты" }
description: { en: "Writes the failing test first, watches it fail, then writes the code that passes it.", ru: "Сначала пишет падающий тест, видит, как он падает, затем пишет код, который его проходит." }
kind: procedure
sources: [obra/superpowers skills/test-driven-development/SKILL.md, obra/superpowers skills/test-driven-development/writing-good-tests.md]
---
For every behaviour you add or change, and for every bug you fix:

1. **Red.** Write one test for one behaviour, named for what it shows ("rejects an empty email"). Use the real code; mock only what you cannot run (the network, the clock, another service).
2. **Watch it fail.** Run it. It must fail, and fail because the behaviour is missing, not because of a typo or an import. A test that passes before the code exists tests nothing; fix the test.
3. **Green.** Write the simplest code that makes it pass. Nothing the test does not ask for.
4. **Run the tests around it**: yours, and those of the code you changed and its callers. Every failure goes into your report, even one you did not cause. The whole suite runs once per turn (dev-gates).
5. **Refactor** with the tests green: names, duplication, small functions. Run again.

Before you write a test, name the change to the code that would make it fail. If you cannot, the test checks nothing. Assert on outputs and visible effects, not on how many times a mock was called. Keep test helpers in test files, never in production code. A bug fix starts with a test that reproduces the bug.
