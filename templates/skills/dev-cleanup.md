---
id: dev-cleanup
title: { en: "Removing what is not needed", ru: "Уборка лишнего" }
description: { en: "Before work is handed in, takes out what the change added or left behind and no longer needs, and proves nothing else moved.", ru: "Перед сдачей работы убирает то, что изменение добавило или оставило и что больше не нужно, и доказывает, что остальное не сдвинулось." }
kind: checklist
sources: [affaan-m/ECC agents/refactor-cleaner.md, addyosmani/agent-skills skills/code-simplification/SKILL.md]
---
Before you hand work in, take out what it does not need. Start from what your change added or left behind; other code stays as it is unless your task names it.

- **Temporary things**: debug logging, scratch scripts, commented-out code, stray files, switches made only for a test.
- **What the change made dead**: functions, imports, flags, settings, dependencies and documents nothing uses any more. Search for every reference first, dynamic ones too. When something may be part of a public interface, or you are not sure, keep it and name it in your report.
- **What the change made twice**: a second way to do what already exists.
- **Simpler code**: only where you can prove behaviour did not change. Pin it with tests, change the structure, run the tests again, and keep the cleanup in its own commit, apart from behaviour commits.
