---
id: dev-tdd
title: { en: "Test-driven development", ru: "Разработка через тесты" }
description: { en: "Writes the failing test first, watches it fail, then writes the code that passes it, in the cycle of the task's kind.", ru: "Сначала пишет падающий тест, видит, как он падает, затем пишет код, который его проходит, по циклу вида задачи." }
kind: procedure
sources: [obra/superpowers skills/test-driven-development/SKILL.md, obra/superpowers skills/test-driven-development/writing-good-tests.md]
---
You can establish a behavior with a failing test and a minimal verified change.

**The first rule: we test our program, not the operating system and not other programs.** Where our code drives another program, a test checks only our side: we started it correctly, passed it the input and parsed its output correctly, that output coming from a recorded sample. A test never waits for another program's work and never depends on machine speed, the clock, a random port or unsorted order.

**The second rule: time in a test is virtual only.** No test waits for or measures real time: not one deadline, wait or pause on the real clock, and no check of elapsed time. A test drives time with a controlled clock (fake timers or the code's injected clock), calls the step directly, or waits for an event or a state with no deadline; the runner's limit on a whole test is the only limit. A test gives the same verdict on any machine at any load.

Use the check assigned by the head under the shared small-task rule. The cycle below applies when that requires a separate test.

Every task is one of four task kinds, and the kind chooses the cycle:

- **Bug:** reproduce it with a failing test, then fix it.
- **Known behaviour:** use the red, green, refactor cycle below in small steps.
- **Unknown path:** first write one acceptance test for what a person sees or the API returns. Within it, timebox a spike, split logic into pure functions, cut the unnecessary and write direct fast tests. A discarded spike needs no tests.
- **Legacy code:** pin behaviour with characterization tests, keep structural commits separate from behaviour commits (Tidy First), then change behaviour under its own test.

For every behaviour you add or change, and for every bug you fix:

1. **Red.** Write one test for one behaviour, named for what it shows ("rejects an empty email"). Use our real code; replace only what is not ours (another program or service, the operating system, the network, the clock) with a recorded sample or a fake.
2. **Watch it fail.** Run that affected test file in your own workspace right away. It must fail because the behaviour is missing, not because of a typo or an import. A characterization test of legacy code passes immediately, and that is correct: it pins current behaviour before structural work. Any other new behaviour test that passes before the code exists tests nothing; fix the test.
3. **Green.** Write the simplest code that makes it pass. Nothing the test does not ask for.
4. **Run the tests around it** in your workspace: name the files for your change and its callers, plus build, types and lint of changed code. Every failure goes into your report, even one you did not cause.
5. **Refactor** with the tests green: names, duplication, small functions. Run again.

Before you write a test, name the change to the code that would make it fail. If you cannot, the test checks nothing. Assert on outputs and visible effects, not on how many times a mock was called. Keep test helpers in test files, never in production code. Submit with requirement -> test links and verification before done evidence. There is no 80% coverage threshold.
