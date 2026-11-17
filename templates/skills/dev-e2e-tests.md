---
id: dev-e2e-tests
title: { en: "End-to-end tests", ru: "Сквозные тесты" }
description: { en: "Pins the most important user flows with tests that drive the real product.", ru: "Закрепляет главные сценарии пользователя тестами, которые управляют настоящим продуктом." }
kind: procedure
sources: [affaan-m/ECC skills/e2e-testing/SKILL.md, openai/skills skills/.curated/playwright/SKILL.md, obra/superpowers skills/systematic-debugging/condition-based-waiting.md]
---
You can pin a few important user flows with reproducible end-to-end tests.

- **The first rule: we test our program, not the operating system and not other programs.** A flow drives our product; where it reaches another program, it uses that program's output from a recorded sample and never waits for its work. Browser tests of our own web screens in three engines stay: that is our program.
- **The second rule: time in a test is virtual only.** A flow never waits on the real clock: no waitForTimeout, no fixed pause, no time limit of our own on an expectation. Our app's own timers (animations, debounces, polling, relative times) run on the page's controlled clock (page.clock), and a flow waits for what the page shows.
- Cover the few flows that matter most end to end: the main thing the product does, and signing in, paying or publishing when it does those. Keep the rest at unit and integration level, where tests are fast.
- Drive the product through the surface its user uses: its interface (by role and visible text on the web, through the platform's test driver elsewhere), its command line, or its public API.
- Start each test from a known state you create in the test; never depend on another test or on shared data.
- Wait for conditions (an element, a response, a line of output), never for a fixed number of seconds.
- On failure keep what shows what happened: a screenshot, the logs, the requests, the output.
- A test that fails sometimes may be weakened or deleted quickly, without a long diagnosis. Never retry it until it turns green or replace it with a skip, and never weaken a check of our own access rights, identity or secret redaction.
- Run named test files of your change in your own workspace when its browser is there; installing that browser is allowed.
