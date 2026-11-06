---
id: dev-work-pipeline
title: { en: "Development pipeline", ru: "Конвейер разработки" }
description: { en: "Where development checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где разработку проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through development. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- A task gets a gate of its own only where a change must not reach the turn's branch unchecked, such as a migration that rewrites existing data (dev-gates).
- Declared money, access, security or data risk wakes security and the red team for that change.
- The CEO approves the exact commit of each release.

## In a batch

- One review of the turn, with every reviewer at once, covers everything the turn changed (dev-gates). Its fixes start with a failing test and get no second review.
- After a batch merges, its affected tests run on one pinned commit. The whole suite runs once, on the final candidate of the turn.

## By sample

- Mutation testing runs once per release, only on the riskiest pure logic and only against its fast tests (dev-engineering-rules).

## By code

- On every task, the tests selected by impact, types, lint, crapper and dryer run on what it changed.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- A reviewer's judgement (dev-review-diff) is a model check that has no example set yet. It adds to the code checks and replaces none of them.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- DEV-HEAD names one owner on the first turn of each product, DEV-TEST or else DEV-QA, who writes its test environment description (dev-test-environment).
- Name the department's own measures in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
