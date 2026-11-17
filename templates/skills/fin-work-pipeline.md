---
id: fin-work-pipeline
title: { en: "Finance pipeline", ru: "Конвейер финансов" }
description: { en: "Where finance checks item by item, in a batch, by sample and by code; read it when laying out work or changing a check.", ru: "Где финансы проверяют по штуке, пакетом, выборкой и кодом; читай, когда раздаешь работу или меняешь проверку." }
kind: procedure
sources: []
---
When assigned to plan or assess finance checks, use the queue's source records, outputs, maker, checker, tolerances and approval policy. Check each item where a mistake cannot be undone, risk adds up item by item, or code cannot check it. Batch the rest with the owner's sample. The department owner is the person named for this department, or the CEO when there is none. The current assignment and task gates select the work route; this plan grants no tool or approval authority.

## Item by item

- Every spend is checked for its amount, budget, business need, vendor, terms and approval limit before a human approves and a different human pays. The requester does not approve their own spend.
- Everything that leaves the company, such as statements, invoices, payment lists and figures for banks or tax, has every key number independently rebuilt from source records and matching before it goes. Its checker must not be its maker and reports findings without fixing the checked work.
- Humans post, pay and file. No agent does.

## In a batch

- A maker draws up the entries and reconciliations of a period, and a different checker checks cut-off, source support, balanced entries, open differences and statements as one close set.
- Variance analysis compares the period's figures with budget and earlier periods, explaining material differences from source evidence rather than guesses.

## By sample

- Control testing picks a sample of entries and approvals without the maker's help and checks that authorized, separate people approved before posting or payment. A failed control goes to the head with what stays at risk until it is fixed.

## By code

- The independent recompute is code, not a model's reading: SQL or a script rebuilds the key numbers from source records before the checker reads the maker's workings, then the checker compares the results.
- Totals, balances that must balance, differences left on a reconciliation and items counted twice go through the same kind of script.
- Each code check has fast tests, including cases it must reject. A check named here that your tools do not run yet stays with a person, item by item, until they do.

## By a model

- No number passes on a model's reading. Reading commentary and assumptions against the numbers is a model check that has no example set yet.
- A model check has a versioned set of examples with known answers, labelled by someone other than its author, and a threshold the department owner sets. Run the set when the check, its prompt, its lists or the provider model changes, not on every item, and count false accepts and false rejects apart. Every miss found in real work becomes a new example. Until a set has run for a check, that check proves nothing: say so and keep a person on what it would pass. An action that cannot be undone keeps its approval item by item, whatever a set shows.

## Descriptions and measures

- For each queue in scope, record its source records, maker, separate checker, tolerance, approvals and sample in the department notebook. Give drafts to the people who approve, pay, post or file; agents perform none of those protected financial actions.
- Name the department's own measures, such as reconciliation accuracy, in the department description: the head sets it with "change_department" (about) under the department's rules. The pipeline report of a turn says when a department has no description.
- Return the proposed check plan, uncovered controls and missing evidence to the person who assigned this work.
