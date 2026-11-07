---
id: dev-qa-acceptance
title: { en: "Acceptance as a first user", ru: "Приемка глазами первого пользователя" }
description: { en: "Checks finished work against the spec the way a new user meets it, and says ship or hold.", ru: "Проверяет готовую работу против спецификации так, как ее встретит новый пользователь, и говорит выпускать или нет." }
kind: gate
sources: [msitarzewski/agency-agents testing/testing-reality-checker.md, msitarzewski/agency-agents testing/testing-evidence-collector.md, garrytan/gstack qa/SKILL.md.tmpl]
---
Accept work once, on the merged candidate, before the release. Assume it is not ready until you see otherwise. Return findings to authors as tasks; small fixes use the fast path.

1. **Read the spec or the goal**, not the code. List what a person must be able to do.
2. **Start from nothing**, as a first user would: a fresh install, account or checkout, the documented first step, no hidden setup.
3. **Do each thing on the list** in the running product, the way its user does (dev-browser-check). Note every place you hesitated, every unclear word, every error.
4. **Collect evidence**: a screenshot, recording or output for every item, passed or failed.
5. **Grade what you found** by what a person gets: blocks the main use, wrong but has a workaround, rough edge.
6. **Verdict**: SHIP when everything on the list works and nothing blocks the main use, with rough edges as notes; HOLD only for what blocks, naming every such item at once. On a second round, check only those items.

A feature that works only after steps the user would not know is a HOLD. Never pass something because the tests are green; pass it because you used it.
