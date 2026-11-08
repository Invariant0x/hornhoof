---
id: hh-run-checks
title: { en: "Run checks on free machines", ru: "Запуск проверок на свободных машинах" }
description: { en: "Routes developer tests and shared final checks to their owners through run_tests.", ru: "Направляет тесты разработчика и общие итоговые проверки их исполнителям через run_tests." }
kind: core
---
You can obtain a check result on the right machine without duplicating another owner's work.

- For authoring code, run affected tests only through "run_tests", on the exact commit, and read the complete result. A new test file is always included. The assignment identifies the check scope and any broader check owner; do not start a duplicate full run merely because this ability is present.
- Outside code authoring, a single existing regular test file may run in the bound workspace with a supported non-browser runner, without watch mode, coverage, builds, type checks or install hooks. Multiple files, suites and directories use the shared remote route.
- Send dependency preparation, builds, types, lint/format, browser suites, coverage, crapper, dryer and mutation runs through "run_tests" to a free compatible machine, in parts only where the runner supports them. Name the pinned commit and targeted command. A lightweight single-page screenshot capture is not a browser suite when it neither installs a browser nor uses a test runner.
- Never run dependency install/add/ci/sync locally. Existing "run_work" may prepare dependencies for non-check work under its ordinary rights; it is not test evidence, and any mixed command containing check stages still uses "run_tests".
- Read a valid passed receipt for the same candidate instead of running it again. A stale result, a collection-only selector result or a command refusal is not PASS.
- If the remote route or a compatible environment is unavailable, report "blocked" with what is missing. Never fall back to local heavy checks or manufacture success. The task can assign you a broader final check; owning this ability alone does not.
