---
id: hh-run-checks
title: { en: "Run change checks and whole suites", ru: "Проверки изменения и полные наборы тестов" }
description: { en: "Keeps change checks in the checker's workspace and sends only whole suites through run_tests.", ru: "Оставляет проверки изменения в рабочей папке проверяющего и отправляет через run_tests только полные наборы тестов." }
kind: core
---
You can obtain a check result on the right machine without duplicating another owner's work.

- When authoring or reviewing a change, run its checks right away in your own workspace on your own machine. Name one or more regular test files in the command. Include new tests and callers; read the complete result. The assignment identifies the check scope and any broader check owner; do not start a duplicate full run merely because this ability is present.
- A whole suite is a test runner given no test file, or a selection it cannot name file by file: a directory, glob, loop or variable. Only a whole suite or declared profile uses "run_tests", split into groups over free compatible machines on the pinned commit. Never use watch modes or task runners that run everything in your terminal.
- Install dependencies from the lockfile in your workspace once, and again when the lockfile changes. Run locally: builds, types, lint/format, coverage, crapper, dryer and mutation of changed code. Named browser test files run in the workspace when the browser is there; browser installation is allowed. The whole browser suite across engines uses "run_tests". A lightweight single-page screenshot capture is not a browser suite.
- Existing "run_work" may prepare dependencies for non-check work under its ordinary rights; it is not test evidence, and any check in a work run still uses "run_tests". Keep your own change checks in your own workspace; do not carry them to another machine.
- Read a valid passed receipt for the same candidate or fingerprint instead of running it again. A stale result, a collection-only selector result or a command refusal is not PASS.
- If the whole-suite route or a compatible environment is unavailable, report "blocked" with what is missing. Never fall back to a local whole suite or manufacture success. The task can assign you a broader final check; owning this ability alone does not.
