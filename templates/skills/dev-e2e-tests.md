---
id: dev-e2e-tests
title: { en: "End-to-end tests", ru: "Сквозные тесты" }
description: { en: "Pins the most important user flows with tests that drive the real app.", ru: "Закрепляет главные сценарии пользователя тестами, которые управляют настоящим приложением." }
kind: procedure
sources: [affaan-m/ECC skills/e2e-testing/SKILL.md, openai/skills skills/.curated/playwright/SKILL.md, obra/superpowers skills/systematic-debugging/condition-based-waiting.md]
---
- Cover the few flows that matter most end to end: sign in, the main thing the product does, paying or publishing if it does that. Keep the rest at unit and route level, where tests are fast.
- Drive the app the way a person does: find elements by role and visible text, type and click, read what appears.
- Start each test from a known state you create in the test; never depend on another test or on shared data.
- Wait for conditions (an element, a response), never for a fixed number of seconds.
- On failure keep a screenshot, the console log and the network log, so the next person can see what happened.
- A test that fails sometimes is a bug in the test or the app; find which before retrying it.
- Run them in CI on every change to the main line and before every release.
