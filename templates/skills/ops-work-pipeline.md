---
id: ops-work-pipeline
title: { en: "Operations pipeline", ru: "Конвейер операций" }
description: { en: "Where operations checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где операции проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through operations. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- Every change others depend on has a rollback plan and a check written before it runs (ops-change-request).
- Approval goes by blast radius: a reversible change inside the department is approved by someone other than its author; one that costs money, changes access for other departments or cannot be rolled back goes, item by item, to the person who decides it.

## In a batch

- The same small reversible change on many machines or accounts goes as one request, with one rollback and one check.
- Failures and capacity are reviewed together over a period (ops-failure-review, ops-capacity-plan).

## By sample

- After a batch change, check a sample of its machines or accounts from the user's side. A failed check rolls the whole batch back first; investigation comes second.
- Compare a sample of the account register with what really exists (ops-account-register).

## By code

- Node health is read from what the machines report, not judged (ops-node-health). The check of a change is a script wherever it can be.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- Reviewing a tool's configuration or a vendor (ops-mcp-config-review, ops-vendor-review) is a model check that has no example set yet.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- OPS-HEAD writes a short description of each request queue and group of machines on its first turn: who depends on it, its blast radius, its rollback and its check. Keep it in the department notebook.
- Name the department's own measures, such as failed changes and time to restore, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
