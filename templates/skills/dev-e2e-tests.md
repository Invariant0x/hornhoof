---
id: dev-e2e-tests
title: { en: "End-to-end tests", ru: "Сквозные тесты" }
description: { en: "Pins the most important user flows with tests that drive the real product.", ru: "Закрепляет главные сценарии пользователя тестами, которые управляют настоящим продуктом." }
kind: procedure
sources: [affaan-m/ECC skills/e2e-testing/SKILL.md, openai/skills skills/.curated/playwright/SKILL.md, obra/superpowers skills/systematic-debugging/condition-based-waiting.md]
---
You can pin a few important user flows with reproducible end-to-end tests.

- **The first rule: we test our program, not the operating system and not other programs.** A flow drives our product; where it reaches another program, it uses that program's output from a recorded sample and never waits for its work. Browser tests of our own web screens in three engines stay: that is our program.
- Cover the few flows that matter most end to end: the main thing the product does, and signing in, paying or publishing when it does those. Keep the rest at unit and integration level, where tests are fast.
- Drive the product through the surface its user uses: its interface (by role and visible text on the web, through the platform's test driver elsewhere), its command line, or its public API.
- Start each test from a known state you create in the test; never depend on another test or on shared data.
- Wait for conditions (an element, a response, a line of output), never for a fixed number of seconds.
- On failure keep what shows what happened: a screenshot, the logs, the requests, the output.
- When a flow is unstable, establish whether it exposes an intermittent product defect or a faulty check. Preserve proof of the harmful behavior and repair the check that produces an unreliable result.
- Run named test files of your change in your own workspace when its browser is there, in Chromium only: Firefox and WebKit run them in the turn's whole release run. Installing that browser is allowed.
