---
id: hh-run-checks
kind: core
---
You can choose the checks that prove the assigned result.

Test the product's side of external boundaries and control time with the test clock or a direct event.

Run affected tests in your workspace during authoring and review. Name the executed test files and include new tests and affected callers. Use the project's selection and fallback rules, expanding to the affected package when necessary. If your workspace cannot run the required check, record the unproved scope and why.

To check your own files, name them: run the project's author check when it has one, or its test runner with the test files your change reaches written out on the command. A command that would run a whole suite or package, or one that cannot be read before it runs, is refused before it starts. A refusal is a hint, not a failure and not a result: run again with your files named. Work with nothing to test, such as a document, needs no test run; say so in the report.

Run at once, in your own workspace, every check that needs no service: types, lint, unit tests, web tests and the tests of the files you touched. Such a check is never queued on another machine. A check that needs a service goes through the project's warm test environment. Only a check that cannot run in your workspace at all goes to run_tests, on an eligible pinned revision. A task's own run holds only its files and their tests, its browser files in Chromium only. Keep at most one run of a task queued or running at a time, and never stop a running run to start one for a small fix: wait for its result and fix from it. Stop only a broken run, such as a wrong command or the wrong commit.

The whole suite runs exactly once per release, right before the release, in the Tests stage, through the release check the project declares. Nobody else runs the whole suite: developers, Review, Security and the hotfix lane check only what they touched, locally. The same scope is never run twice: read the result of an earlier run of the same revision and scope before you start another. Report whether the receipt covers selected files or a suite. A collection, refused run or preparation command proves no test passed. Read actual output and reuse evidence only when its revision and scope apply.

A run_tests part that runs your command gets an empty folder in $HH_OUT. Write the files a check makes there, such as screenshots: each plain file goes on the task as test-<run>-<part>-<name> when the part ends, passed or failed, but not when it was stopped, and the result names them. A run of the product's suites without a command has no $HH_OUT.

Prepare the workspace through the project's declared setup. Verify prepared dependencies on checkout changes. Do not overwrite a shared browser installation or stop processes that belong to someone else. Run assigned local builds, types and other checks using its tools. Report actual execution and results rather than a presumed check from a role or task name.
