---
id: dev-work-pipeline
title: { en: "Development pipeline", ru: "Конвейер разработки" }
description: { en: "Where development checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где разработку проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
For `small: true`, use the fast path in hh-lead-tasks and hh-task-flow: only affected tests on the task, no separate gates or reports. Matrices, complexity metrics, duplicate checks and extra quality checks belong to the shared turn review and checks.

How work moves through development. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- A task gets a gate of its own only where a change must not reach the turn's branch unchecked, such as a migration that rewrites existing data (dev-gates).
- Declared money, access, security or data risk wakes security and the red team for that change.
- The CEO approves the exact commit of each release.

## In a batch

- One review of the turn, with every reviewer at once, covers everything the turn changed (dev-gates). Its fixes start with a failing test and get no second review.
- After a batch merges, its affected tests run on one pinned commit. The whole suite runs once, on the final candidate of the turn.

## By sample

- The test engineer or QA runs mutation testing once per turn on its final candidate, only on the riskiest pure logic and only against its fast tests (dev-engineering-rules).

## By code

- Developers write a failing test before the change, run only affected tests selected by impact through run_tests, and submit the tests written, green results and commit SHA. The test engineer or QA owns the remaining checks once per turn on the final candidate (dev-gates), without duplicate runs.
- The test engineer or QA runs types, lint, crapper and dryer as shared final checks.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- A reviewer's judgement (dev-review-diff) is a model check that has no example set yet. It adds to the code checks and replaces none of them.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- The system builds each product's test harness from its repository and keeps it on every machine. DEV-HEAD answers for it, and when a repository needs a description names who writes it, DEV-TEST or else DEV-QA (dev-test-environment).
- Name the department's own measures in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.

Before you ask the CEO to approve a release: follow the project's version scheme; without one, the one in dev-ci-release. Set the version, write the release notes and run `check-release`. For an incompatible change, propose increasing the first digit to the CEO. Show screenshots of what changes for people (`hh-attach FILE`, light and dark, each language) and a link to the branch comparison.
