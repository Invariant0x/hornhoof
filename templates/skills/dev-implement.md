---
id: dev-implement
title: { en: "Implementing a task", ru: "Выполнение задачи" }
description: { en: "Takes a brief from start to a proved, committed result in small increments.", ru: "Доводит задание от начала до проверенного и закоммиченного результата небольшими шагами." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md, addyosmani/agent-skills skills/incremental-implementation/SKILL.md, addyosmani/agent-skills skills/source-driven-development/SKILL.md]
---
1. **Read the brief twice.** List what it asks for and how it will be checked. If anything changes what you build and the brief does not settle it, ask before writing code (hh-ask-dont-guess).
2. **Read before writing.** First the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, the README), then the code you will touch and the code that calls it. Look for something that already does what you need; reuse it instead of writing a second one. Check library behaviour in its docs or source, not from memory.
3. **Work in increments.** Each increment is a test and the code that passes it, small enough to undo. Keep the build green between increments.
4. **Stay inside the brief.** No drive-by refactors or new features. Write down what you noticed for the report.
5. **Commit** each finished increment on your branch with a message that says why and how it was proved. Never push to the main branch; releases reach it after the gates.
6. **Finish**: run the formatter, the linter and the type checker (dev-language-rules), crapper, dryer and mutator on what you changed (dev-engineering-rules), the full test suite and the brief's check, then report with hh-report-to-head: files changed, commands and results, and concerns.

If you are stuck for more than a few attempts, stop and report BLOCKED with what you tried; do not keep guessing.
