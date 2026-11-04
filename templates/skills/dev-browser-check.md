---
id: dev-browser-check
title: { en: "Checking the running product", ru: "Проверка запущенного продукта" }
description: { en: "Runs the product the way its user meets it, walks the flow and keeps evidence.", ru: "Запускает продукт так, как его встречает пользователь, проходит сценарий и сохраняет доказательства." }
kind: procedure
sources: [openai/skills skills/.curated/playwright/SKILL.md, anthropics/skills skills/webapp-testing/SKILL.md]
---
Unit tests do not show what a user meets. For any change a user can notice:

1. Start the product the way the project documents it, or use the preview your head gave you. Never test against production data.
2. Use it through the surface its user uses: a web page with Playwright (already installed on the machine; verify the browser opens instead of running `playwright install` by hand) or your browser tool; a command-line tool through its commands; a service through its public API; a library through a small program that calls it the way its users do; any other app through its own test driver, emulator or simulator. Act as a person or a calling program would.
3. Walk the whole flow the change touches, then its edges: empty data, an error from what it depends on, a slow answer, a long name, a small screen where the product has screens.
4. Check every language and theme the product has.
5. Watch logs, the console and failed requests: any error is a finding.
6. Keep evidence of each state you checked (screenshots, recordings, command output, responses) named by what they show, and list it in your report.

If the product or the browser does not start, report BLOCKED with the command and its output instead of installing a browser by hand. A check you could not run is not a pass.
