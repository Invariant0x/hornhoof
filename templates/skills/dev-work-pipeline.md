---
id: dev-work-pipeline
title: { en: "Development pipeline", ru: "Конвейер разработки" }
description: { en: "Where development checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где разработку проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
`small: true` work takes the fast path in hh-lead-tasks; what it leaves out waits for the shared turn review and checks.

How work moves through development. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- A task gets a gate of its own only where a change must not reach the turn's branch unchecked, such as a migration that rewrites existing data (dev-gates).
- Declared money, access, security or data risk wakes security and the red team for that change.
- The CEO approves the exact commit of each release (dev-ci-release).

## In a batch

- One review of the turn, with every reviewer at once, covers everything the turn changed (dev-gates).
- After a batch merges, its affected tests run on one pinned commit. The whole suite runs once, on the final candidate of the turn.

## By sample

- Mutation testing samples the riskiest pure logic against its fast tests (dev-testing-policy).

## By code

- The code checks are tests selected by impact, types, lint, crapper and dryer. Who runs each and when is in dev-testing-policy.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- A reviewer's judgement is a model check that has no example set yet. It adds to the code checks and replaces none of them.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- The system builds each product's test harness from its repository and keeps it on every machine, with the tools of the languages DEV-HEAD and the owner chose. DEV-HEAD answers for it, and when a repository needs a description names who writes it, DEV-TEST or else DEV-QA (dev-test-environment).
- Name the department's own measures in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
