---
id: hh-run-checks
title: { en: "Run change checks and whole suites", ru: "Проверки изменения и полные наборы тестов" }
description: { en: "Runs affected checks in the workspace and uses the shared runner for assigned release checks.", ru: "Запускает проверки изменений в рабочей папке, а проверки выпуска передает общему инструменту." }
kind: core
---
You can choose the checks that prove the assigned result.

Test the product's side of external boundaries and control time with the test clock or a direct event.

Run affected tests in your workspace during authoring and review. Name the executed test files and include new tests and affected callers. Use the project's selection and fallback rules, expanding to the affected package when necessary. If your workspace cannot run the required check, record the unproved scope and why.

Use run_tests for the assigned release scope on an eligible pinned revision. Check what you touched with local tests of the files it reaches; every test runs together once per release, on the turn's branch or a release branch before main, or on main. A release recheck follows the project's rule for failed and affected checks on the new candidate. Report whether the receipt covers selected files, a suite or the whole release. A collection, refused run or preparation command proves no test passed. Read actual output and reuse evidence only when its revision and scope apply.

Prepare the workspace through the project's declared setup. Verify prepared dependencies on checkout changes. Do not overwrite a shared browser installation or stop processes that belong to someone else. Run assigned local builds, types and other checks using its tools. Report actual execution and results rather than a presumed check from a role or task name.
