---
id: dev-implement
title: { en: "Implementing a task", ru: "Выполнение задачи" }
description: { en: "Takes a brief from start to a proved, committed result in small increments.", ru: "Доводит задание от начала до проверенного и закоммиченного результата небольшими шагами." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md, addyosmani/agent-skills skills/incremental-implementation/SKILL.md, addyosmani/agent-skills skills/source-driven-development/SKILL.md]
---
1. **Read the brief twice.** List what it asks for and how it will be checked. If anything changes what you build and the brief does not settle it, ask before writing code (hh-ask-dont-guess).
2. **Follow the coding cycle for the task kind.** The head marks acceptance, meaning what a person sees, a risk class of money, access, security, data or none, and one of four task kinds. The risk class wakes security and red team review.
   - **Bug:** first write a failing test that reproduces it, then fix it.
   - **Known behaviour:** work test-first in small red, green, refactor steps (dev-tdd).
   - **Unknown path:** first write one acceptance test for what a person sees or the API returns. Within it, timebox a spike, split logic into pure functions, cut the unnecessary and write direct fast tests (T1). A discarded spike needs no tests.
   - **Legacy code:** pin behaviour with characterization tests, keep structural commits separate from behaviour commits (Tidy First), then change behaviour under its own test.
3. **Read before writing.** First the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, the README), then the code you will touch and the code that calls it. Look for something that already does what you need; reuse it instead of writing a second one. Check library behaviour in its docs or source, not from memory.
4. **Work in increments.** Each increment is a test and the code that passes it, small enough to undo. Keep the build green between increments. Keep WIP to one task in progress and one awaiting review. A red turn branch comes before any new task. There is no 80% coverage threshold.
5. **Stay inside the brief.** No drive-by refactors or new features. Write down what you noticed for the report.
6. **Commit** each finished increment on your branch with a message that says why and how it was proved. Never push to the main branch; releases reach it after the gates.
7. **Finish**: run author checks through `run_tests` on your exact pushed branch commit (`hh-run-checks`), keeping local terminal runs to at most one regular test file during RED/GREEN. Supply the changed paths explicitly to the project's impact selector (such as the selector helpers under `scripts/test/`, without assuming automatic test-environment selection before that runner port is connected), run only the selected dependent tests with coverage, and always include newly added test files even when no import-graph edge reaches them. When changes touch paths outside the import graph, when a language or adapter is unsupported or unavailable, or when in doubt, run the complete affected package, and run database migrations both up and down (reporting explicitly when either direction is unsupported). Also run the formatter, the linter and the type checker (dev-language-rules), crapper and dryer on your branch's files (dev-engineering-rules), and the brief's check; one final candidate run across all packages on the turn's branch remains with the test engineer. Record the selector input, selected inventory, fallback reasons and completed `run_tests` run, part and commit outcomes, keeping unconnected environment-runner integration marked `NOT_RUN`, and report requirement -> test links and verification before done evidence with hh-report-to-head: files changed, commands and results, and concerns.

If you are stuck for more than a few attempts, stop and report BLOCKED with what you tried; do not keep guessing.
