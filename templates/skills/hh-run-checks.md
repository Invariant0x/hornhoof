---
id: hh-run-checks
title: { en: "Run change checks and whole suites", ru: "Проверки изменения и полные наборы тестов" }
description: { en: "Keeps change checks in the checker's workspace and sends only whole suites through run_tests.", ru: "Оставляет проверки изменения в рабочей папке проверяющего и отправляет через run_tests только полные наборы тестов." }
kind: core
---
You can obtain a check result on the right machine without duplicating another owner's work.

- First: we test our program, not the operating system and not other programs. Never check or wait for another program's work; test our side (start, input, parsed output) on a recorded sample, independent of speed, clock, random port or unsorted order.
- Second: time in a test is virtual only. Never wait for or measure real time: use a controlled clock, a direct step call, or an event/state wait with no deadline.
- When authoring or reviewing a change, run checks right away in your own workspace, naming one or more regular test files including new tests and callers, and read the full output. The assignment identifies the check scope; do not start a duplicate full run. An assignment can widen what is checked, never move change checks to "run_tests"; use "run_tests" for one only when your own workspace cannot run it, and say what is missing.
- Contributors on individual tasks (in echelons or parallel turnkey teams) and intermediate gates never call "run_tests" or run a whole suite on a working task branch. Only a whole suite (no test file, or a directory, glob, loop or variable) or declared profile uses "run_tests", split into groups over free compatible machines on the pinned commit, strictly once before release by one release-assembly owner on the combined release branch before main (or on the single commit of a standalone release). Never run everything in your terminal or watch mode.
- Install dependencies from the lockfile in your workspace once, and again when the lockfile changes; when the manifest names its dependencies, they are already in place, so install only when they are missing or after the lockfile changes. Run locally: builds, types, lint/format, coverage, crapper, dryer and mutation of changed code. Named browser test files run in the workspace; browser installation is allowed (a lightweight single-page screenshot capture is not a browser suite, while a whole browser suite across engines uses "run_tests").
- Existing "run_work" prepares non-check work and is not test evidence; any check in a work run still uses "run_tests". Reuse a valid passed receipt for the same candidate or fingerprint; stale, collection-only or command refusal is not PASS. If the whole-suite route is unavailable, report "blocked" with what is missing and never fall back to a local whole suite.
