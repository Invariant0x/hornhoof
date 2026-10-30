---
id: sup-bug-report
title: { en: "Bug report for development", ru: "Отчет об ошибке для разработки" }
description: { en: "Writes a bug report that Development can reproduce and prioritise without asking support again.", ru: "Пишет отчет об ошибке, который разработка может воспроизвести и оценить без повторных вопросов к поддержке." }
kind: procedure
sources: []
---
Write each report so a developer who never saw the ticket can reproduce the bug in minutes.

- **Title**: what breaks, where, for whom. "CSV export fails for files over 10 MB on the Team plan", not "Export broken".
- **Steps**: numbered, from a clean start, with the exact data or settings needed.
- **Expected** and **actual** result, with the exact error text.
- **Environment**: product version, plan, app or browser and its version, operating system, language, region, time with time zone.
- **Evidence**: screenshots, request ids, log lines you could see, with personal data removed.
- **Reproduced**: every time, sometimes (how often), or not reproduced (what you tried).
- **Impact**: number of customers and tickets so far (with ticket ids), revenue at risk if known, any workaround.
- **Severity** as support sees it: P1 to P4 from triage, with one line of why.
- **Customer promise**: what the customer was told; no fix date is ever promised.

Hand the report to your head, who sends it to Development through the orchestrator. Do not contact developers directly. Leave out customer names, emails and private content unless Development needs that exact item to reproduce. When new tickets arrive for the same bug, add them to the existing report instead of writing a new one.
