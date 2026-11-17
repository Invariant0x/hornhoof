---
id: dev-implement
title: { en: "Implementing a task", ru: "Выполнение задачи" }
description: { en: "Takes a brief from start to a proved, committed result in small increments.", ru: "Доводит задание от начала до проверенного и закоммиченного результата небольшими шагами." }
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md, addyosmani/agent-skills skills/incremental-implementation/SKILL.md, addyosmani/agent-skills skills/source-driven-development/SKILL.md]
---
You can implement an assigned software change from its brief to a proved result.

1. Read the brief and repository rules before writing. Name the acceptance, risk class and task kind; ask the task owner only when a missing decision changes the result, spend, access or promise.
2. Read the code and its callers, look for an existing solution and verify unfamiliar library behavior from its source or official documentation. Reuse the project's language, design system and conventions.
3. Use the task's assigned check. For a bug, reproduce it with a failing test. For known behavior, use red/green/refactor. For an unknown path, start with one acceptance check and a bounded disposable spike. For legacy work, pin current behavior before a structural change. A small visual change can use the owner's permitted visual check; never invent a bad test merely to satisfy a ritual.
4. Work in small reversible increments. Keep one active implementation area, coordinate shared files and use a separate branch/workspace for independent work while a check is pending. No unrelated cleanup or extra feature enters the task.
5. Run affected checks in your own workspace right away. Use the project's explicit selector to name test files, including new tests and callers. When your workspace cannot run a check or routes/configuration/migrations/fixtures or an unavailable graph cannot bound the impact, run named local tests of the touched area and say what is missing as the fallback reason. Install from the lockfile and run builds, types and quality checks locally. Read the whole log; an import failure before preparation is not proof of an application bug.
6. Inspect your diff cold for correctness, data loss, hidden errors, access boundaries and unnecessary complexity. Check a user-facing surface on an isolated fixture or stand when the change reaches one; a browser is needed only for a web page. This own inspection is not an independent approval.
7. Commit, push your task branch and submit its exact SHA, requirements-to-tests, observed results and concerns. Follow the task's actual gates and integration route, not an assumed downstream team.

When the project has an author check, run it in your own workspace on your exact commit before you submit, and read its actual result before claiming readiness. Submitting starts no test run, so submission alone is not a passed check.

External Review and Security engineers work only in echelon tasks. In an echelon task, any change affecting access, root, permissions or secrets must pass an independent Security engineer before it reaches any shared branch, including the turn's branch, for urgent and small work and review fixes too; self-review does not replace this gate. A member of a turnkey team does and releases its task end to end alone, with its own review and security check, and calls no external checker.

Do not publish, change production data or broaden access without the appropriate explicit approval. If the same attempts fail without a new hypothesis, report the evidence and missing condition rather than continuing to guess.
