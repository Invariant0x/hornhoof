---
id: fin-work-pipeline
title: { en: "Finance pipeline", ru: "Конвейер финансов" }
description: { en: "Where finance checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где финансы проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
How work moves through finance. Check each item only where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Everything else goes in a batch, with a sample on top. The department owner is the person named for this department, or the CEO when there is none.

## Item by item

- Every spend passes the spend gate before a human approves and pays it (fin-spend-approval).
- Everything that leaves the company, such as statements, invoices, payment lists and figures for banks or tax, has every key number recomputed and matching before it goes (fin-independent-recompute).
- Humans post, pay and file. No agent does.

## In a batch

- A maker draws up the entries and reconciliations of a period, and a different checker takes them through the close as one set (fin-close-management).
- Variance analysis goes over the numbers of the period together (fin-variance-analysis).

## By sample

- Control testing picks a sample of entries and approvals without the maker's help and looks for the evidence that each control ran (fin-controls-testing). A failed control goes to the head with what stays at risk until it is fixed.

## By code

- The independent recompute is code, not a model's reading: SQL or a script rebuilds the key numbers from source records, and the checker compares them with the maker's (fin-independent-recompute).
- Totals, balances that must balance, differences left on a reconciliation and items counted twice go through the same kind of script.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- No number passes on a model's reading. Reading commentary and assumptions against the numbers is a model check that has no example set yet.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- FIN-HEAD writes a short description of each regular queue of work, such as the close and spend requests, on its first turn: its source records, maker, checker, tolerance and sample. Keep it in the department notebook.
- Name the department's own measures, such as reconciliation accuracy, in the department description: ask the orchestrator with "tell_orchestrator" to set it. The pipeline report of a turn says when a department has no description.
- A new company has these rules from its start and writes its descriptions on its first turn.
