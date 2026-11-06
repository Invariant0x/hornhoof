---
id: dev-implement
title: { en: "Implementing a task", ru: "Выполнение задачи" }
description: { en: "Takes a brief from start to a proved, committed result in small increments.", ru: "Доводит задание от начала до проверенного и закоммиченного результата небольшими шагами." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md, addyosmani/agent-skills skills/incremental-implementation/SKILL.md, addyosmani/agent-skills skills/source-driven-development/SKILL.md]
---
For `small: true`, the fast path in hh-task-flow replaces this procedure, and what it leaves out waits for the shared turn review and checks. If the work grows, tell whoever gave it to you and take this path.

1. **Read the brief twice.** List what it asks for and how it will be checked. If anything changes what you build and the brief does not settle it, ask before writing code (hh-ask-dont-guess).
2. **Follow the coding cycle of the task's kind**, one of the four task kinds in dev-tdd. The brief marks acceptance, meaning what a person sees, a risk class of money, access, security, data or none, and the kind. When it does not, mark them yourself and say so in your report.
3. **Read before writing.** First the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING.md, the README), then the code you will touch and the code that calls it. Look for something that already does what you need; reuse it instead of writing a second one. Check library behaviour in its docs or source, not from memory.
4. **Work in increments.** Each increment is a test and the code that passes it, small enough to undo. Keep the build green between increments. Keep WIP to one task in progress and one awaiting review; while its shared batch check runs, start the next independent piece of work in a separate worktree. A red turn branch comes before any new task. There is no 80% coverage threshold.
5. **Stay inside the brief.** No drive-by refactors or new features. Write down what you noticed for the report.
6. **Commit** each finished increment on your branch with a message that says why and how it was proved. Never push to the main branch; releases reach it after the gates.
7. **Finish**: run only affected tests through `run_tests` on your pushed branch commit (`hh-run-checks`), selected as T2 in dev-testing-policy says. Submit through Hornhoof; when the author check is enabled, submission starts it on the exact submitted SHA and keeps its run and part evidence with the task. Submit the tests written, their requirement -> test links and verification before done evidence, the green affected-test result and commit SHA.

If you are stuck for more than a few attempts, stop and report BLOCKED with what you tried; do not keep guessing.
