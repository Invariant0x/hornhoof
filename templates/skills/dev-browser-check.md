---
id: dev-browser-check
title: { en: "Checking in a real browser", ru: "Проверка в настоящем браузере" }
description: { en: "Opens the running app in a browser, walks the flow and keeps screenshots as evidence.", ru: "Открывает запущенное приложение в браузере, проходит сценарий и сохраняет скриншоты как доказательство." }
kind: procedure
sources: [openai/skills skills/.curated/playwright/SKILL.md, anthropics/skills skills/webapp-testing/SKILL.md]
---
Unit tests do not show what a person sees. For any change a person can see:

1. Start the app the way the project documents, or use the preview your head gave you. Never test against production data.
2. Drive it with Playwright (installed on your machine) or the browser tool you have: open the page, act by visible text and roles, the way a person would.
3. Walk the whole flow the change touches, then its edges: empty data, an error from the server, a slow answer, a long name, a phone-width window.
4. Check both themes and both languages when the app has them.
5. Watch the browser console and failed network requests; any error is a finding.
6. Save screenshots of each state you checked with names that say what they show, and list them in your report.

If the app does not start, report BLOCKED with the command and its output. A check you could not run is not a pass.
