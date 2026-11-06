---
id: hh-run-checks
title: { en: "Run checks on free machines", ru: "Запуск проверок на свободных машинах" }
description: { en: "Runs at most one regular test file locally during RED/GREEN and sends heavy checks through run_tests.", ru: "Запускает локально не более одного обычного тестового файла в RED/GREEN, а тяжелые проверки отправляет через run_tests." }
kind: core
---
Keep heavy verification off your working terminal and use one shared remote check route:

- **One local file for RED and GREEN.** In your terminal, run at most one existing regular test file inside your bound workspace (tracked or newly created untracked) with a supported non-browser runner during RED and GREEN, without watch mode, coverage, build, typecheck or pre/post install hooks. Never run multiple test files, suites or directories in your terminal.
- **Heavy checks go through "run_tests".** Send every heavy stage through "run_tests" to a free compatible machine: dependency preparation for checks, builds, type checks, linters, format checks, multi-file or package test runs, browser suites (even a single browser spec), coverage, crapper, dryer and scheduled mutation runs. Name the exact commit and targeted command for what your change touches. The whole test suite belongs only to the designated final stage of a turn, never to an individual task or fix round.
- **Dependencies and "run_work".** Never run dependency install, add, ci or sync commands locally, even when adding a feature dependency. Editing manifest or lockfile text is ordinary work. Existing "run_work" may prepare dependencies for non-check work under its normal rights, never counts as "run_tests" or T2 check evidence, and any mixed command that includes build, type, lint, test, browser, coverage or quality stages must go through "run_tests".
- **Lightweight captures.** A lightweight single-page screenshot capture for visual inspection is not a browser test suite; a browser executable name alone does not make a capture a suite, provided it neither installs browsers nor runs a test runner.
- **No local fallback and no fake PASS.** When "run_tests" or a compatible remote environment is unavailable, report "blocked" to your head with what is missing, and never fall back to running heavy checks locally. A command refusal is never PASS or completed test evidence; send the check through "run_tests" and wait for its finished log.
