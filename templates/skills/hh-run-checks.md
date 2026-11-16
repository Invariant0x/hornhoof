---
id: hh-run-checks
title: { en: "Run change checks and whole suites", ru: "Проверки изменения и полные наборы тестов" }
description: { en: "Keeps change checks in the checker's workspace and sends only whole suites through run_tests.", ru: "Оставляет проверки изменения в рабочей папке проверяющего и отправляет через run_tests только полные наборы тестов." }
kind: core
---
You can obtain a check result on the right machine without duplicating another owner's work.

- First: we test our program, not the operating system and not other programs; never wait for another program's work; test our side (start, input, parsed output) on a recorded sample, independent of speed, clock, random port or unsorted order. Second: time in a test is virtual only; use a controlled clock, direct step call or deadline-free state wait.
- When authoring or reviewing, run checks right away in your own workspace, naming one or more regular test files (including new tests and callers), and read full output. The assignment identifies the check scope; do not start a duplicate full run. An assignment can widen what is checked, never move change checks to "run_tests": when your workspace cannot run a check or bound its impact, run named local tests of the touched area, say what is missing and leave it to the release owner's "run_tests" run once per release candidate on the combined release candidate before main (or standalone release commit).
- Only a whole suite (no test file, or a directory, glob, loop or variable) or declared profile uses "run_tests", split into groups over free compatible machines on the pinned commit.
- Install dependencies from the lockfile in your workspace once, and again after the lockfile changes; when the manifest names its dependencies, they are already in place, so install only when they are missing or after the lockfile changes. Run locally: builds, types, lint/format, coverage, crapper, dryer and mutation of changed code. Named browser test files run in the workspace; browser installation is allowed (a lightweight single-page screenshot capture is not a browser suite; whole browser suites across engines use "run_tests").
- Existing "run_work" prepares non-check work and is not test evidence; any check in a work run needing a whole suite uses "run_tests" only on the release candidate. Reuse a valid passed receipt for the same candidate or fingerprint; stale, collection-only or command refusal is not PASS. If the whole-suite route is unavailable, report "blocked"; never fall back to a local whole suite.
