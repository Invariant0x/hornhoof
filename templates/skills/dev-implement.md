---
id: dev-implement
kind: procedure
sources: [obra/superpowers skills/subagent-driven-development/implementer-prompt.md, addyosmani/agent-skills skills/incremental-implementation/SKILL.md, addyosmani/agent-skills skills/source-driven-development/SKILL.md]
---
You can implement an assigned software change from its brief to a proved result.

1. Read the brief and repository rules before writing. Name the acceptance, risk class and task kind; ask the task owner only when a missing decision changes the result, spend, access or promise.
2. Read the code and its callers, look for an existing solution and verify unfamiliar library behavior from its source or official documentation. Reuse the project's language, design system and conventions.
3. Use the task's assigned check. For a bug, reproduce it with a failing test. For known behavior, use red/green/refactor. For an unknown path, start with one acceptance check and a bounded disposable spike. For legacy work, pin current behavior before a structural change. A small visual change can use the owner's permitted visual check; never invent a bad test merely to satisfy a ritual.
4. Work in small reversible increments. Keep one active implementation area, coordinate shared files and use a separate branch/workspace for independent work while a check is pending. No unrelated cleanup or extra feature enters the task.
5. Run affected checks in your own workspace. Use the project's explicit selector for named files, including new tests and callers. Apply its declared fallback and expand to the affected package when impact cannot be bounded. Record the fallback reason. If required checks cannot run, name the missing prerequisite and unproved scope. Where the project has a lockfile, install from the lockfile and run builds, types and quality checks locally. Read the actual log and report preparation failures separately.
6. Inspect your diff cold for correctness, data loss, hidden errors, access boundaries and unnecessary complexity. Check a user-facing surface on an isolated fixture or stand when the change reaches one; a browser is needed only for a web page. This own inspection is not an independent approval.
7. Commit, push your task branch and submit its exact SHA, requirements-to-tests, observed results and concerns. Follow the task's actual gates and integration route, not an assumed downstream team.

When the project has an author check, run it in your own workspace on your exact commit before you submit, and read its actual result before claiming readiness. Submitting starts no test run, so submission alone is not a passed check.

Security reads the whole turn branch once, after Review and before Tests, and fixes what it finds there; nothing goes to main without that pass; the hotfix lane's fix gets its own Security read before its patch release.

Do not publish, change production data or broaden access without the appropriate explicit approval. If the same attempts fail without a new hypothesis, report the evidence and missing condition rather than continuing to guess.
