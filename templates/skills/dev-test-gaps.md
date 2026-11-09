---
id: dev-test-gaps
title: { en: "Finding test gaps", ru: "Поиск пробелов в тестах" }
description: { en: "Finds the behaviours a change has that no test would catch breaking.", ru: "Находит поведение изменения, поломку которого не поймает ни один тест." }
kind: procedure
sources: [anthropics/claude-plugins-official plugins/pr-review-toolkit/agents/pr-test-analyzer.md, garrytan/gstack review/specialists/testing.md, anthropics/knowledge-work-plugins engineering/skills/testing-strategy/SKILL.md]
---
You can identify missing tests for concrete harmful failure cases.

**The first rule: we test our program, not the operating system and not other programs.** A gap is our code that no test would catch breaking. The work of another program or of the operating system is never a gap; where our code drives another program, the gap to look for is our side: starting it, its input, and parsing its output from a recorded sample.

**The second rule: time in a test is virtual only.** No test waits for or measures real time: not one deadline, wait or pause on the real clock, and no check of elapsed time. A test drives time with a controlled clock (fake timers or the code's injected clock), calls the step directly, or waits for an event or a state with no deadline; the runner's limit on a whole test is the only limit. A test gives the same verdict on any machine at any load.

1. List the behaviours the change adds or alters: inputs, outputs, errors, side effects, states.
2. For each one, find the test that would fail if it broke. As a manual check, break the code on purpose (flip a condition, drop a line) and run the affected tests; if nothing fails, that is a gap. Put the code back. This manual check is not mutation testing, which runs on its own schedule.
3. Look first where bugs live: boundaries (empty, one, many, the maximum), error paths, retries, concurrency, time, permissions, migrations of existing data.
4. Check that the tests are honest: they would fail without the change, they assert on results, they do not depend on order, the clock, machine speed, a random port or another program's work.
5. Write the missing tests yourself when your brief allows it, smallest first, each failing before the fix it pins. Otherwise list them for the author, each with the input and the expected result.
6. Report coverage you added and gaps you left, and which of them a person would notice first.

A flaky test needs no long diagnosis: weaken or delete it, never skip it or retry it until it turns green, and cover our code it checked with an our-side test on a recorded sample where one can be written. A check of our own access rights, identity or secret redaction is never weakened.
